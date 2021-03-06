"use strict";

// Module Requirements
const _ = require('lodash');
const proc = require('child_process');
const join = require('path').join;
const async = require('async');
const util = require('util');
const EventEmitter = require('events').EventEmitter;
const streamBuffers = require("stream-buffers");
const through = require('through');
const path = require('path');
const mkdirp = require('mkdirp');
const fs = require('fs');

require('colors');

function newStreamBuffer() {
  return new streamBuffers.WritableStreamBuffer({
      initialSize: (25 * 1024),
      incrementAmount: (10 * 1024)
  });
}

function SpawnMocha(opts) {
  if (opts.logFile && !_.isFunction(opts.logFile)) {
    throw new Error(`LogFile must be a function that returns a path. Quitting`);
  }
  const _this = this;
  opts = opts || {};
  const queue = async.queue(function (task, done) {
    // Setup
    const bin = _.isFunction(opts.bin) ? opts.bin() : opts.bin ||
      join(__dirname, '..', 'node_modules', '.bin', 'mocha');
    const env = _.clone(_.isFunction(opts.env) ? opts.env(task) : opts.env || process.env);

    // Generate arguments
    const args = [];

    _.each(opts.flags, function (val, key) {
      if(_.isFunction(val)) val = val();
      args.push((key.length > 1 ? '--' : '-') + key);
      if (_.isString(val) || _.isNumber(val)) {
        args.push(val);
      }
    });

    const merged = newStreamBuffer();
    const stdout = newStreamBuffer();
    const stderr = newStreamBuffer();

    // Execute Mocha
    const child = proc.spawn(bin, args.concat(task.files), {env: env});

    child.stdout.pipe(merged);
    child.stderr.pipe(merged);

    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);

    // When done...
    child.on('close', function(errCode) {
      const mergedContents = merged.size() ? merged.getContentsAsString("utf8") : '';
      const errContents = stderr.size() ? stderr.getContentsAsString("utf8") : '';
      const outContents = stdout.size() ? stdout.getContentsAsString("utf8") : '';

      // emit test file data at the end
      _this.emit('data', { task, merged: mergedContents, stderr: errContents, stdout: outContents });
      let err = null;

      if(errCode) {
        const message = `Errors for file (stderr): ${task.files.join(', ')}`;
        err = new Error(message);
        err.exitCode = errCode;
        err.files = task.files;
        err.stderr = errContents;
        err.stdout = outContents;
        err.merged = mergedContents;
        err.code = errCode;
      }

      done(err);
    });
  }, opts.concurrency || 1);

  queue.drain = function() {
    _this.emit('end');
  };

  let taskNum = 0;
  this.add = function(files) {
    taskNum ++;
    if (!_.isArray(files)) {
      files = [files];
    }
    const task = {taskNum: taskNum, files: files};
    queue.push(task, function(err) {
      if(err){
        _this.emit('error', err, files);
      }
    });
  };
}

util.inherits(SpawnMocha, EventEmitter);

function mochaStream(opts) {
  opts = _.merge({}, opts, {
    inspect: true, // TODO: not sure if this argument works
    flags: {
      reporter: 'mocha-circleci-reporter',
      reporterOptions: 'includePending=true',
    },
  });

  const errors = [];
  const spawnMocha = new SpawnMocha(opts);
  const stream = through(function write(file) {
    spawnMocha.add(file.path);
  }, function () {
  });

  stream.on('error', function (err) { /* avoid unhandled stream error */ });

  spawnMocha.on('data', function (testFileData) {
    console.log(testFileData.merged);
    if (opts.logFile) {
      const logFilePath = opts.logFile(testFileData.task);
      const logFileDir = path.dirname(logFilePath);

      mkdirp(logFileDir, function(err) {
        if (err) {
          console.error(`Could not create log file directory '${logFileDir}' for file '${logFilePath}'`);
        } else {
          fs.writeFileSync(logFilePath, testFileData.merged);
        }
      });
    }
    stream.emit('data', testFileData);
  });
  spawnMocha.on('error', function (err) {
    errors.push(err);
  });
  spawnMocha.on('end', function () {
    if (errors.length > 0) {
      _.each(errors, function (err) {
        // error in spec files
        if (err.stderr) {
          console.error(`Errors for file ${err.files.join(', ')}`);
          console.error(err.stderr);
          // error outside spec files
        } else {
          console.error(err.stack);
        }
      });
      stream.emit('error', errors);
    }
    stream.emit('end', errors);

  });

  return stream;
}

module.exports = {
  SpawnMocha: SpawnMocha,
  mochaStream: mochaStream
};
