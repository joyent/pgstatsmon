/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2018, Joyent, Inc.
 */

var helper = require('./helper');

var mod_assert = require('assert-plus');
var mod_bunyan = require('bunyan');
var mod_path = require('path');
var mod_vasync = require('vasync');

var VError = require('verror').VError;

/*
 * badquery.tst.js: run some invalid queries and see how pgstatsmon handles it.
 */

function main()
{
	var badQuery;

	/* spin up the dependent pgstatsmon and run the test cases */
	mod_vasync.pipeline({
		'funcs': [
			function (_, cb) {
				badQuery = new BadQuery(cb);
			},
			function (_, cb) {
				badQuery.run_invalid_query(cb);
			}
		]
	}, function (err, res) {
		mod_assert.ifError(err);
		badQuery.shutDown(function (err2) {
			mod_assert.ifError(err2);
		});
	});
}

function BadQuery(callback)
{
	var self = this;

	/* allow user to provide an alternate configuration file path */
	var mon_args = {};
	if (process.argv.length === 3) {
		mon_args.config_file = process.argv[2];
	}

	this.log = new mod_bunyan({
		'name': mod_path.basename(__filename),
		'level': process.env['LOG_LEVEL'] || 'fatal'
	});
	mon_args.log = this.log;

	this.mon = helper.getMon(mon_args);
	this.client = helper.createClient();

	/* make sure we know when it's safe to use pgstatsmon */
	this.mon.start(function (err) {
		if (err) {
			self.log.error(err, 'could not start pgstatsmon');
			process.exit(1);
		}
		self.mon.tick(function () {
			clearInterval(self.mon.pm_intervalObj);
			callback();
		});
		self.prom_target = self.mon.getTarget();
	});
}

BadQuery.prototype.shutDown = function (callback) {
	this.mon.stop();
	this.client.end(callback);
};

/* Tests */

/*
 * Make pgstatsmon run a query that results in an error being returned from
 * Postgres.
 */
BadQuery.prototype.run_invalid_query = function (callback)
{
	var self = this;
	var queries;
	var counter;
	var initial_value;

	/* bogus query that causes Postgres to return an error */
	queries = [ {
		'name': 'test_bad_query',
		'sql': 'SELECT *',
		'statkey': 'non_existent',
		'metadata': [ 'no_metadata' ],
		'counters': [],
		'gauges': []
	} ];

	var labels = {
		'query': queries[0].name,
		'backend': self.mon.pm_pgs[0]['name']
	};

	this.mon.initializeMetrics(queries);
	/*
	 * since mon.initializeMetrics() drops all of the data, we need to get
	 * a pointer to the new PrometheusTarget
	 */
	self.prom_target = this.mon.getTarget();

	mod_vasync.pipeline({
		'funcs': [
			/* make sure counters are created */
			function (_, cb) {
				self.mon.tick(cb);
			},
			/* get the initial query error count */
			function (_, cb) {
				counter =
				    self.prom_target.pe_collector.getCollector(
					'pg_query_error');
				initial_value = counter.getValue(labels);
				self.log.debug({ 'iv': initial_value });
				cb();
			},
			/*
			 * kick off another round of stat updates
			 *
			 * In this case only one query is executed, and it
			 * should result in an error counter being incremented.
			 */
			function (_, cb) {
				self.mon.tick(cb);
			}
		]
	/* make sure pgstatsmon incremented the error counter */
	}, function (err, results) {
		if (err) {
			callback(new VError(err, 'error running invalid' +
			    ' query'));
			return;
		}
		mod_assert.equal(counter.getValue(labels),
		    initial_value + 1, 'one query error');

		callback();
	});
};

main();
