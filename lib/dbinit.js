/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright 2019 Joyent, Inc.
 */

var mod_assert = require('assert-plus');
var mod_bunyan = require('bunyan');
var mod_pg = require('pg');
var mod_vasync = require('vasync');
var mod_util = require('util');
var mod_verror = require('verror');

var mod_pgclient = require('./pgclient');

var ConnectTimeoutError = 'ConnectTimeoutError';
var PostgresInRecoveryError = 'PostgresInRecoveryError';

/*
 * dbinit.js: set up an unprivileged Postgres user, and make sure it can get
 * information from typically filtered tables.
 *
 * pgstatsmon shouldn't need to do most of the things a typical database user
 * can do, like create other users, create databases, eat up a lot of network
 * connections, etc. At the same time, pgstatsmon needs to know some things that
 * normal users aren't supposed to know. Those are things like queries that
 * are being run by other users (superusers), and information about downstream
 * replicas (IP addresses, WAL positions, etc.).
 *
 * This file aims to create a Postgres role for pgstatsmon that gives us the
 * two things mentioned above: restricted access to potentially dangerous
 * actions, and unrestricted access to information about what the database is
 * doing.
 *
 * To accomplish this, this file:
 * - Connects to Postgres as the 'postgres' superuser
 * - Creates a 'pgstatsmon' role with limited privileges
 * - Creates a few functions that will allow pgstatsmon to learn more about
 *   how Postgres is operating (allows it to read everything from
 *   pg_stat_progress_vacuum, etc.)
 *
 * The steps that create users or functions don't run if the target backend is
 * identified as being a synchronous or asynchronous replica.
 *
 */

/*
 * connect to the database as a superuser
 */
function connect_to_database(args, callback) {
	var client;
	var superuser = 'postgres';
	var query_timeout = args.conf.query_timeout;
	var connect_timeout = args.conf.connect_timeout;

	var create_client = mod_pgclient.pgCreate({
		'queryTimeout': query_timeout,
		'user': superuser,
		'database': args.conf.targetdb,
		'log': args.conf.log
	});

	var timer = setTimeout(function () {
		client.removeAllListeners('connect');
		if (client.connection &&
		    client.connection.stream) {
		    client.connection.stream.destroy();
		}
		args.client = null;
		callback(new mod_verror.VError({
			'name': ConnectTimeoutError
		}));
	}, connect_timeout);

	client = create_client({
		'name': args.conf.name,
		'address': args.conf.hostname,
		'port': args.conf.port
	});

	client.on('connect', function () {
		clearTimeout(timer);
		args.client = client;
		callback();
	});
}

/*
 * If this isn't the Postgres primary then we can't do anything else since this
 * is a read-only database. In this case, bail out early.
 */
function stop_if_standby(args, callback) {
	var query = 'SELECT pg_is_in_recovery();';
	var is_in_recovery = false;

	var res;
	res = args.client.query(query);
	res.once('row', function (row) {
		is_in_recovery = row.pg_is_in_recovery;
	});

	res.on('error', function (err) {
		callback(err);
	});

	res.on('end', function () {
		if (is_in_recovery) {
			callback(new mod_verror.VError({
				'name': PostgresInRecoveryError
			}));
			return;
		}
		callback();
	});
}

/*
 * Get the version number of the Postgres server. This is used later to
 * determine whether or not we should set up some of the stat collection
 * functions (replication stats, vacuum progress stats).
 */
function get_db_version(args, callback) {
	var query;
	var res;
	var server_version_num;

	server_version_num = 'server_version_num';
	query = mod_util.format(
	    'select current_setting(\'%s\')::integer as %s',
	    server_version_num, server_version_num);

	res = args.client.query(query);
	res.once('row', function (row) {
		args.pg_version = row[server_version_num];
	});

	res.on('error', function (err) {
		callback(err);
	});

	res.on('end', function () {
		callback();
	});
}

/*
 * create a restricted Postgres user for pgstatsmon
 */
function create_user(args, callback) {
	var ALREADY_CREATED_ERR_CODE = '42710';

	/* restrict the user as much as possible */
	var options = ['NOSUPERUSER', 'NOCREATEDB', 'NOCREATEROLE', 'NOINHERIT',
	    'NOREPLICATION', 'CONNECTION LIMIT 2', 'LOGIN'].join(' ');
	var query = 'CREATE ROLE %s WITH %s;';
	query = mod_util.format(query, args.conf.user, options);

	run_rowless_query(query, args, function (err) {
		if (err && err.code !== ALREADY_CREATED_ERR_CODE) {
			/* this wasn't a 'user already created' error */
			callback(err);
			return;
		}
		callback();
	});
}

/*
 * Create functions for pgstatsmon to call to get unfiltered stats.
 * Some pg_catalog relations allow non-superusers to SELECT on them, but
 * hide some information. pg_stat_activity and pg_stat_replication are
 * the two examples that are most relevant to metric collection.
 *
 * pgstatsmon will call the function which will execute the underlying
 * query as the postgres superuser that created the function. The result
 * is returned as a single string, which can be parsed as a table by
 * issuing 'SELECT *' on the function. The resulting table should look
 * identical to the unfiltered pg_catalog table.
 *
 * The 'SECURITY DEFINER' bit means that these functions are executed as if
 * they are being run by the user that created it, _not_ the user that called
 * it.
 *
 */

/*
 * create a function for pgstatsmon to view unfiltered pg_stat_activity stats
 */
function create_activity_function(args, callback) {
	var query;
	query = 'CREATE OR REPLACE FUNCTION public.get_stat_activity()'
	    + ' RETURNS SETOF pg_stat_activity AS \'SELECT * FROM'
	    + ' pg_catalog.pg_stat_activity;\' LANGUAGE SQL VOLATILE'
	    + ' SECURITY DEFINER;';

	run_rowless_query(query, args, callback);
}

/*
 * create a function for pgstatsmon to view unfiltered pg_stat_replication stats
 */
function create_replication_function(args, callback) {
	if (args.pg_version < 90400) {
		/* not supported */
		callback();
		return;
	}
	var query;
	query = 'CREATE OR REPLACE FUNCTION public.get_stat_replication()'
	    + ' RETURNS SETOF pg_stat_replication AS \'SELECT * FROM'
	    + ' pg_catalog.pg_stat_replication;\' LANGUAGE SQL VOLATILE'
	    + ' SECURITY DEFINER;';

	run_rowless_query(query, args, callback);
}

/*
 * create a function for pgstatsmon to gather vacuum progress
 *
 * This Postgres function's return values changed when it began tracking the
 * start time of vacuums. Postgres does not allow 'CREATE OR REPLACE FUNCTION'
 * directives to change the name, argument types, or return types of functions.
 * We must first explicitly drop the old function before creating a new function
 * with a different signature.
 *
 * The DROP + CREATE is done in one logical operation for convenience and
 * because it most closely resembles the behavior of previous versions.
 */
function create_progress_vacuum_function(args, callback) {
	if (args.pg_version < 90600) {
		/* not supported */
		callback();
		return;
	}
	var query;
	query = 'DROP FUNCTION IF EXISTS get_stat_progress_vacuum(); '
	+ 'CREATE FUNCTION public.get_stat_progress_vacuum('
	+ 'out schemaname name, '
	+ 'out relname name, '
	+ 'out relid oid, '
	+ 'out vacuum_mode text, '
	+ 'out query_start double precision, '
	+ 'out phase bigint, '
	+ 'out heap_blks_total bigint, '
	+ 'out heap_blks_scanned bigint, '
	+ 'out heap_blks_vacuumed bigint, '
	+ 'out index_vacuum_count bigint, '
	+ 'out max_dead_tuples bigint, '
	+ 'out num_dead_tuples bigint) '
	+ ' RETURNS SETOF record'
	+ ' AS $$'
	+ ' SELECT'
	+ '	  N.nspname AS schemaname,'
	+ '	  T.relname AS relname,'
	+ '	  T.relid AS relid,'
	+ '	  CASE'
	+ '	    WHEN'
	+ '	      A.query ~ \'^autovacuum.*(to prevent wraparound)\''
	+ '	    THEN \'aggressive_autovacuum\''
	+ '	    WHEN'
	+ '	      A.query ~ \'^autovacuum\''
	+ '	    THEN \'autovacuum\''
	+ '	    WHEN'
	+ '	      A.query ~* \'^vacuum\''
	+ '	    THEN \'manual_vacuum\''
	+ '	    ELSE \'unknown\''
	+ '	  END AS vacuum_mode,'
	+ '	  EXTRACT (EPOCH FROM A.query_start) AS query_start,'
	+ '	  S.param1+1 AS phase,'
	+ '	  S.param2 AS heap_blks_total,'
	+ '	  S.param3 AS heap_blks_scanned,'
	+ '	  S.param4 AS heap_blks_vacuumed,'
	+ '	  S.param5 AS index_vacuum_count,'
	+ '	  S.param6 AS max_dead_tuples,'
	+ '	  S.param7 AS num_dead_tuples'
	+ ' FROM pg_stat_get_progress_info(\'VACUUM\') AS S '
	+ ' JOIN pg_database D ON (S.datid = D.oid) '
	+ ' JOIN pg_stat_all_tables As T ON (T.relid = S.relid)'
	+ ' JOIN pg_stat_activity A ON (S.pid = A.pid)'
	+ ' JOIN pg_class C ON (C.oid = S.relid)'
	+ ' JOIN pg_namespace N ON (N.oid = C.relnamespace) '
	+ ' $$'
	+ ' LANGUAGE SQL VOLATILE'
	+ ' SECURITY DEFINER;';

	run_rowless_query(query, args, callback);
}

/*
 * wrapper function to run queries that don't return useful rows
 */
function run_rowless_query(query, args, callback) {
	var log = args.conf.log;
	var res;

	log.info({
		'query': query,
		'backend': args.conf.hostname,
		'database': args.conf.targetdb
	}, 'executing query');
	res = args.client.query(query);

	res.on('row', function () {});
	res.on('error', function (err) {
		callback(err);
	});
	res.on('end', function () {
		callback();
	});
}

/*
 * Caller provides the following arguments:
 * - user, the name of the user/role to create in Postgres
 * - hostname, the hostname of the Postgres instance on which to create the
 *   role
 * - port, the port number that the given Postgres instance is listening on
 * - targetdb, the database that the user will live in
 * - query_timeout, time in ms to wait before marking a query as failed
 * - connect_timeout, time in ms to wait before failing a connection attempt
 * - log, bunyan-style logger object
 */
function setup_monitoring_user(args, callback) {
	mod_assert.object(args, 'args');
	mod_assert.object(args.log, 'args.log');
	mod_assert.string(args.user, 'args.user');
	mod_assert.number(args.port, 'args.port');
	mod_assert.string(args.hostname, 'args.hostname');
	mod_assert.string(args.targetdb, 'args.targetdb');
	mod_assert.number(args.query_timeout, 'args.query_timeout');
	mod_assert.number(args.connect_timeout, 'args.connect_timeout');

	var log = args.log;
	var arg = {
		'conf': args,
		'client': null,
		'pg_version': null
	};
	mod_vasync.pipeline({
		'funcs': [
			connect_to_database,
			get_db_version,
			stop_if_standby,
			create_user,
			create_activity_function,
		        create_replication_function,
			create_progress_vacuum_function
		],
		'arg': arg
	}, function (err, results) {
		/* ignore 'postgres in recovery' error */
		if (err &&
		    mod_verror.hasCauseWithName(err, PostgresInRecoveryError)) {
			log.info({
				'backend': args.hostname
			}, 'PG in recovery, skipping initial setup');
			err = null;
		}
		if (arg.client) {
			arg.client.destroy();
		}
		var rv = {
		    'pg_version': arg.pg_version
		};
		callback(err, rv);
	});
}

module.exports = {
	setup_monitoring_user: setup_monitoring_user
};
