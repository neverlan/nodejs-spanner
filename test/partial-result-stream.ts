/*!
 * Copyright 2016 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

import * as assert from 'assert';
const checkpointStream = require('checkpoint-stream');
const concat = require('concat-stream');
import * as extend from 'extend';
import * as proxyquire from 'proxyquire';
import * as through from 'through2';
import {util} from '@google-cloud/common-grpc';

let checkpointStreamOverride;
function fakeCheckpointStream() {}
fakeCheckpointStream.obj = (...args) => {
  return (checkpointStreamOverride || checkpointStream.obj).apply(null, args);
};

// tslint:disable-next-line variable-name no-any
let FakeRowBuilderOverrides: any = {};
class FakeRowBuilder {
  calledWith_: IArguments;
  constructor() {
    this.calledWith_ = arguments;
  }
  addRow() {
    if (!FakeRowBuilderOverrides.addRow) {
      return this;
    }
    return FakeRowBuilderOverrides.addRow.apply(this, arguments);
  }

  build() {
    if (!FakeRowBuilderOverrides.build) {
      return this;
    }
    return FakeRowBuilderOverrides.build.apply(this, arguments);
  }

  flush() {
    if (!FakeRowBuilderOverrides.flush) {
      return this;
    }
    return FakeRowBuilderOverrides.flush.apply(this, arguments);
  }

  toJSON() {
    if (!FakeRowBuilderOverrides.toJSON) {
      return this;
    }
    return FakeRowBuilderOverrides.toJSON.apply(this, arguments);
  }
}

describe('PartialResultStream', () => {
  let partialResultStreamModule;
  let partialResultStreamCached;

  let fakeRequestStream;
  let partialResultStream;

  const RESULT_WITH_TOKEN = {
    metadata: {
      rowType: {
        fields: [],
      },
    },
    resumeToken: '...',
    values: [{}],
  };
  const RESULT_WITHOUT_TOKEN = {
    metadata: {
      rowType: {
        fields: [],
      },
    },
    values: [{}],
  };
  const RESULT_WITHOUT_VALUE = {
    metadata: {
      rowType: {
        fields: [],
      },
    },
    resumeToken: '...',
    values: [],
  };
  const RESULT_WITH_STATS = extend(RESULT_WITH_TOKEN, {
    stats: {},
  });

  before(() => {
    partialResultStreamModule =
        proxyquire('../src/partial-result-stream.js', {
          'checkpoint-stream': fakeCheckpointStream,
          './row-builder.js': {RowBuilder: FakeRowBuilder},
        }).partialResultStream;
    partialResultStreamCached = extend({}, partialResultStreamModule);
  });

  beforeEach(() => {
    FakeRowBuilderOverrides = {};
    checkpointStreamOverride = null;
    fakeRequestStream = through.obj();

    extend(partialResultStreamModule, partialResultStreamCached);

    partialResultStream = partialResultStreamModule(() => {
      return fakeRequestStream;
    });
  });

  describe('stream', () => {
    beforeEach(() => {
      FakeRowBuilderOverrides.addRow = function(row) {
        this.row = row;
      };

      FakeRowBuilderOverrides.build = util.noop;

      FakeRowBuilderOverrides.flush = function() {
        return this.row;
      };

      FakeRowBuilderOverrides.toJSON = (obj) => {
        return [obj];
      };
    });

    it('should only push rows when there is a token', done => {
      let eventsEmitted = 0;

      function assertDoesNotEmit() {
        done();  // will cause test to fail
      }

      function assertDoesEmit(row) {
        eventsEmitted++;

        if (eventsEmitted < 3) {
          assert.strictEqual(row, RESULT_WITHOUT_TOKEN);
        } else {
          assert.strictEqual(row, RESULT_WITH_TOKEN);
          done();
        }
      }

      partialResultStream.on('data', assertDoesNotEmit);
      fakeRequestStream.push(RESULT_WITHOUT_TOKEN);
      fakeRequestStream.push(RESULT_WITHOUT_TOKEN);
      partialResultStream.removeListener('data', assertDoesNotEmit);

      partialResultStream.on('data', assertDoesEmit);
      fakeRequestStream.push(RESULT_WITH_TOKEN);
      fakeRequestStream.push(null);
    });

    it('should emit the raw response', done => {
      fakeRequestStream.push(RESULT_WITH_TOKEN);
      fakeRequestStream.push(null);

      partialResultStream.on('error', done)
          .on('response',
              response => {
                assert.strictEqual(response, RESULT_WITH_TOKEN);
                done();
              })
          .resume();
    });

    it('should effectively skip rows without values', done => {
      fakeRequestStream.push(RESULT_WITHOUT_VALUE);
      fakeRequestStream.push(null);

      partialResultStream.on('error', done).pipe(concat(rows => {
        assert.strictEqual(rows.length, 0);
        done();
      }));
    });

    it('should not queue more than 10 results', done => {
      for (let i = 0; i < 11; i += 1) {
        fakeRequestStream.push(RESULT_WITHOUT_TOKEN);
      }
      fakeRequestStream.push(null);

      partialResultStream.on('error', done).pipe(concat(rows => {
        assert.strictEqual(rows.length, 11);
        done();
      }));
    });

    it('should emit the row stats', done => {
      setImmediate(() => {
        fakeRequestStream.push(RESULT_WITH_STATS);
        fakeRequestStream.push(null);
      });

      partialResultStream.on('error', done)
          .on('data', () => {})
          .on('stats', stats => {
            assert.strictEqual(stats, RESULT_WITH_STATS.stats);
            done();
          });
    });

    describe('RowBuilder', () => {
      it('should create a RowBuiler instance', done => {
        const fields = [];
        const row = extend(true, {}, RESULT_WITH_TOKEN);
        row.metadata.rowType.fields = fields;

        FakeRowBuilderOverrides.addRow = function() {
          assert.strictEqual(this.calledWith_[0], fields);
          done();
        };

        fakeRequestStream.push(row);
        fakeRequestStream.push(null);

        partialResultStream.on('error', done).resume();
      });

      it('should run chunks through RowBuilder', done => {
        const builtRow = {};
        let wasBuildCalled = false;

        FakeRowBuilderOverrides.addRow = (row) => {
          assert.strictEqual(row, RESULT_WITH_TOKEN);
        };

        FakeRowBuilderOverrides.build = () => {
          wasBuildCalled = true;
        };

        FakeRowBuilderOverrides.flush = () => {
          return builtRow;
        };

        fakeRequestStream.push(RESULT_WITH_TOKEN);
        fakeRequestStream.push(null);

        partialResultStream.on('error', done).pipe(concat(rows => {
          assert.strictEqual(wasBuildCalled, true);
          assert.strictEqual(rows[0], builtRow);
          done();
        }));
      });

      it('should return the formatted row as JSON', done => {
        const options = {
          json: true,
          jsonOptions: {},
        };

        const partialResultStream = partialResultStreamModule(() => {
          return fakeRequestStream;
        }, options);

        const formattedRow = {
          toJSON(options_) {
            assert.strictEqual(options_, options.jsonOptions);
            done();
          },
        };

        FakeRowBuilderOverrides.flush = () => {
          return formattedRow;
        };

        fakeRequestStream.push(RESULT_WITH_TOKEN);
        fakeRequestStream.push(null);

        partialResultStream.on('error', done).resume();
      });
    });

    it('should resume if there was an error', done => {
      // This test will emit four rows total:
      // - Two rows
      // - Error event (should retry)
      // - Two rows
      // - Confirm all rows were received.
      // tslint:disable-next-line no-any
      const fakeCheckpointStream: any = through.obj();
      fakeCheckpointStream.reset = util.noop;
      checkpointStreamOverride = () => {
        return fakeCheckpointStream;
      };

      const firstFakeRequestStream = through.obj();
      const secondFakeRequestStream = through.obj();

      let numTimesRequestFnCalled = 0;

      function requestFn(resumeToken) {
        numTimesRequestFnCalled++;

        if (numTimesRequestFnCalled === 1) {
          setTimeout(() => {
            firstFakeRequestStream.push(RESULT_WITH_TOKEN);
            fakeCheckpointStream.emit('checkpoint', RESULT_WITH_TOKEN);
            firstFakeRequestStream.push(RESULT_WITH_TOKEN);
            fakeCheckpointStream.emit('checkpoint', RESULT_WITH_TOKEN);

            setTimeout(() => {
              // This causes a new request stream to be created.
              firstFakeRequestStream.emit('error', new Error('Error.'));
              firstFakeRequestStream.end();
            }, 50);
          }, 50);

          return firstFakeRequestStream;
        }

        if (numTimesRequestFnCalled === 2) {
          assert.strictEqual(resumeToken, RESULT_WITH_TOKEN.resumeToken);

          setTimeout(() => {
            secondFakeRequestStream.push(RESULT_WITH_TOKEN);
            fakeCheckpointStream.emit('checkpoint', RESULT_WITH_TOKEN);
            secondFakeRequestStream.push(RESULT_WITH_TOKEN);
            fakeCheckpointStream.emit('checkpoint', RESULT_WITH_TOKEN);

            secondFakeRequestStream.end();
          }, 500);

          return secondFakeRequestStream;
        }
        return null;
      }

      partialResultStreamModule(requestFn)
          .on('error', done)
          .pipe(concat(rows => {
            assert.strictEqual(rows.length, 4);
            done();
          }));
    });

    it('should emit rows and error when there is no token', done => {
      const error = new Error('Error.');

      let eventsEmitted = 0;

      partialResultStream
          .on('data',
              row => {
                eventsEmitted++;
                assert.strictEqual(row, RESULT_WITHOUT_TOKEN);
              })
          .on('error', err => {
            assert.strictEqual(eventsEmitted, 3);
            assert.strictEqual(err, error);
            done();
          });

      // No rows with tokens were emitted, so this should destroy the stream.
      fakeRequestStream.push(RESULT_WITHOUT_TOKEN);
      fakeRequestStream.push(RESULT_WITHOUT_TOKEN);
      fakeRequestStream.push(RESULT_WITHOUT_TOKEN);
      fakeRequestStream.destroy(error);
    });

    it('should let user abort request', done => {
      fakeRequestStream.abort = () => {
        done();
      };

      const partialResultStream = partialResultStreamModule(() => {
        return fakeRequestStream;
      });

      partialResultStream.emit('reading');
      partialResultStream.abort();
    });

    it('should silently no-op abort if no active request', done => {
      // If no request is ever made, then there should be no active
      // stream to be aborted.
      fakeRequestStream.abort = () => {
        done(new Error('No request ever made; nothing to abort.'));
      };

      // Create a partial result stream and then abort it, without
      // ever sending a request.
      const partialResultStream = partialResultStreamModule(() => {
        return fakeRequestStream;
      });
      partialResultStream.abort();
      done();
    });

    it('should let user abort the most recent request', done => {
      fakeRequestStream.abort = () => {
        done(new Error('Wrong stream was aborted.'));
      };

      // tslint:disable-next-line no-any
      const secondFakeRequestStream: any = through.obj();
      secondFakeRequestStream.abort = () => {
        done();  // this is the one we want to call
      };

      let numTimesRequestFnCalled = 0;

      const partialResultStream = partialResultStreamModule(() => {
        numTimesRequestFnCalled++;

        if (numTimesRequestFnCalled === 1) {
          return fakeRequestStream;
        }

        if (numTimesRequestFnCalled === 2) {
          setImmediate(() => {
            partialResultStream.abort();
          });
          return secondFakeRequestStream;
        }
      });

      partialResultStream.emit('reading');

      // Destroy the stream to trigger a new request stream to be created.
      partialResultStream.on('error', util.noop);
      fakeRequestStream.push(RESULT_WITH_TOKEN);
      fakeRequestStream.destroy(new Error('Error.'));
    });
  });
});
