"use strict";
var util       = require('util');
var stream     = require('stream');
var co         = require('co');
var _          = require('underscore');
var Q          = require('q');
var moment     = require('moment');
var vucoin     = require('vucoin');
var hashf      = require('./hashf');
var dos2unix   = require('./dos2unix');
var logger     = require('./logger')('sync');
var rawer      = require('../lib/rawer');
var constants  = require('../lib/constants');
var Peer       = require('../lib/entity/peer');
var multimeter = require('multimeter');

const CONST_BLOCKS_CHUNK = 500;
const EVAL_REMAINING_INTERVAL = 1000;
const COMPUTE_SPEED_ON_COUNT_CHUNKS = 8;

module.exports = Synchroniser;

function Synchroniser (server, host, port, conf, interactive) {

  let that = this;

  var speed = 0, syncStart = new Date(), times = [syncStart], blocksApplied = 0;
  var baseWatcher = interactive ? new MultimeterWatcher() : new LoggerWatcher();

  // Wrapper to also push event stream
  let watcher = {
    writeStatus: baseWatcher.writeStatus,
    downloadPercent: (pct) => {
      if (pct !== undefined && baseWatcher.downloadPercent() < pct) {
        that.push({ download: pct });
      }
      return baseWatcher.downloadPercent(pct);
    },
    appliedPercent: (pct) => {
      if (pct !== undefined && baseWatcher.appliedPercent() < pct) {
        that.push({ applied: pct });
      }
      return baseWatcher.appliedPercent(pct);
    },
    end: baseWatcher.end
  };

  stream.Duplex.call(this, { objectMode: true });

  // Unused, but made mandatory by Duplex interface
  this._read = () => null;
  this._write = () => null;

  if (interactive) {
    logger.mute();
  }

  // Services
  var PeeringService     = server.PeeringService;
  var BlockchainService  = server.BlockchainService;

  var dal = server.dal;

  var vucoinOptions = {
    timeout: constants.NETWORK.SYNC_LONG_TIMEOUT
  };

  this.sync = (to, chunkLen, askedCautious, nopeers) => {
    let logInterval;
    chunkLen = chunkLen || CONST_BLOCKS_CHUNK;
    logger.info('Connecting remote host...');
    return co(function *() {
      let toApply = [];

      function incrementBlocks(increment) {
        blocksApplied += increment;
        let now = new Date();
        if (times.length == COMPUTE_SPEED_ON_COUNT_CHUNKS) {
          times.splice(0, 1);
        }
        times.push(now);
        let duration = times.reduce(function(sum, t, index) {
          return index == 0 ? sum : (sum + (times[index] - times[index - 1]));
        }, 0);
        speed = (chunkLen * (times.length  - 1)) / Math.round(Math.max(duration / 1000, 1));
        // Reset chrono
        syncStart = new Date();
        if (watcher.appliedPercent() != Math.floor((blocksApplied + localNumber) / remoteNumber * 100)) {
          watcher.appliedPercent(Math.floor((blocksApplied + localNumber) / remoteNumber * 100));
        }
      }

      try {
        var node = yield getVucoin(host, port, vucoinOptions);
        logger.info('Sync started.');

        var lCurrent = yield dal.getCurrentBlockOrNull();

        //============
        // Blockchain
        //============
        logger.info('Downloading Blockchain...');
        watcher.writeStatus('Connecting to ' + host + '...');
        var rCurrent = yield Q.nbind(node.blockchain.current, node)();
        var remoteVersion = rCurrent.version;
        if (remoteVersion < 2) {
          throw Error("Could not sync with remote host. UCP version is " + remoteVersion + " (Must be >= 2)")
        }
        var localNumber = lCurrent ? lCurrent.number : -1;
        var remoteNumber = Math.min(rCurrent.number, to || rCurrent.number);

        // We use cautious mode if it is asked, or not particulary asked but blockchain has been started
        var cautious = (askedCautious === true || (askedCautious === undefined && localNumber >= 0));

        // Recurrent checking
        logInterval = setInterval(() => {
          if (remoteNumber > 1 && speed > 0) {
            var remain = (remoteNumber - (localNumber + 1 + blocksApplied));
            var secondsLeft = remain / speed;
            var momDuration = moment.duration(secondsLeft*1000);
            watcher.writeStatus('Remaining ' + momDuration.humanize() + '');
          }
        }, EVAL_REMAINING_INTERVAL);

        // Prepare chunks of blocks to be downloaded
        var chunks = [];
        for (let i = localNumber + 1; i <= remoteNumber; i = i + chunkLen) {
          chunks.push([i, Math.min(i + chunkLen - 1, remoteNumber)]);
        }

        // Prepare the array of download promises. The first is the promise of already downloaded blocks
        // which has not been applied yet.
        toApply = [Q.defer()].concat(chunks.map(() => Q.defer()));
        toApply[0].resolve([localNumber + 1, localNumber]);

        // Chain download promises, and start download right now
        chunks.map((chunk, index) =>
          // When previous download is done
          toApply[index].promise.then(() =>
            co(function *() {
              // Download blocks and save them
              watcher.downloadPercent(Math.floor(chunk[0] / remoteNumber * 100));
              var blocks = yield Q.nfcall(node.blockchain.blocks, chunk[1] - chunk[0] + 1, chunk[0]);
              watcher.downloadPercent(Math.floor(chunk[1] / remoteNumber * 100));
              chunk[2] = blocks;
            })
            // Resolve the promise
              .then(() =>
                toApply[index + 1].resolve(chunk))
              .catch((err) => {
                toApply[index + 1].reject(err);
                throw err;
              })
          ));

        // Do not use the first which stands for blocks applied before sync
        let toApplyNoCautious = toApply.slice(1);
        for (let i = 0; i < toApplyNoCautious.length; i++) {
          // Wait for download chunk to be completed
          let chunk = yield toApplyNoCautious[i].promise;
          let blocks = chunk[2];
          blocks = _.sortBy(blocks, 'number');
          if (cautious) {
            for (let j = 0, len = blocks.length; j < len; j++) {
              yield applyGivenBlock(cautious, remoteNumber)(blocks[j]);
              incrementBlocks(1);
            }
          } else {
            yield BlockchainService.saveBlocksInMainBranch(blocks, remoteNumber);
            incrementBlocks(blocks.length);
            // Free memory
            if (i >= 0 && i < toApplyNoCautious.length - 1) {
              blocks.splice(0, blocks.length);
              chunk.splice(0, chunk.length);
            }
            if (i - 1 >= 0) {
              delete toApplyNoCautious[i - 1];
            }
          }
        }

        // Specific treatment for nocautious
        if (!cautious && toApply.length > 1) {
          let lastChunk = yield toApplyNoCautious[toApplyNoCautious.length - 1].promise;
          let lastBlocks = lastChunk[2];
          let lastBlock = lastBlocks[lastBlocks.length - 1];
          yield BlockchainService.obsoleteInMainBranch(lastBlock);
        }

        // Finished blocks
        yield Q.all(toApply).then(() => watcher.appliedPercent(100.0));

        // Save currency parameters given by root block
        let rootBlock = yield server.dal.getBlock(0);
        yield BlockchainService.saveParametersForRootBlock(rootBlock);

        //=======
        // Peers
        //=======
        if (!nopeers) {
          watcher.writeStatus('Peers...');
          yield syncPeer(node);
          var merkle = yield dal.merkleForPeers();
          var getPeers = Q.nbind(node.network.peering.peers.get, node);
          var json2 = yield getPeers({});
          var rm = new NodesMerkle(json2);
          if(rm.root() != merkle.root()){
            var leavesToAdd = [];
            var json = yield getPeers({ leaves: true });
            _(json.leaves).forEach((leaf) => {
              if(merkle.leaves().indexOf(leaf) == -1){
                leavesToAdd.push(leaf);
              }
            });
            for (let i = 0; i < leavesToAdd.length; i++) {
              var leaf = leavesToAdd[i];
              var json3 = yield getPeers({ "leaf": leaf });
              var jsonEntry = json3.leaf.value;
              var sign = json3.leaf.value.signature;
              var entry = {};
              ["version", "currency", "pubkey", "endpoints", "block"].forEach((key) => {
                entry[key] = jsonEntry[key];
              });
              entry.signature = sign;
              watcher.writeStatus('Peer ' + entry.pubkey);
              logger.info('Peer ' + entry.pubkey);
              yield PeeringService.submitP(entry, false, to === undefined);
            }
          }
          else {
            watcher.writeStatus('Peers already known');
          }
        }
        watcher.end();
        that.push({ sync: true });
        logger.info('Sync finished.');
      } catch (err) {
        for (let i = toApply.length; i >= 0; i--) {
          toApply[i] = Promise.reject("Canceled");
        }
        that.push({ sync: false, msg: err });
        if (logInterval) {
          clearInterval(logInterval);
        }
        err && watcher.writeStatus(err.message || String(err));
        watcher.end();
        throw err;
      }
    });
  };

  function getVucoin(theHost, thePort, options) {
    return Q.Promise(function(resolve, reject){
      vucoin(theHost, thePort, function (err, node) {
        if(err){
          return reject('Cannot sync: ' + err);
        }
        resolve(node);
      }, options);
    });
  }

  function applyGivenBlock(cautious, remoteCurrentNumber) {
    return function (block) {
      // Rawification of transactions
      block.transactions.forEach(function (tx) {
        tx.raw = ["TX", constants.DOCUMENTS_VERSION, tx.signatories.length, tx.inputs.length, tx.outputs.length, tx.comment ? '1' : '0', tx.locktime || 0].join(':') + '\n';
        tx.raw += tx.signatories.join('\n') + '\n';
        tx.raw += tx.inputs.join('\n') + '\n';
        tx.raw += tx.outputs.join('\n') + '\n';
        if (tx.comment)
          tx.raw += tx.comment + '\n';
        tx.raw += tx.signatures.join('\n') + '\n';
        tx.version = constants.DOCUMENTS_VERSION;
        tx.currency = conf.currency;
        tx.issuers = tx.signatories;
        tx.hash = ("" + hashf(rawer.getTransaction(tx))).toUpperCase();
      });
      blocksApplied++;
      speed = blocksApplied / Math.round(Math.max((new Date() - syncStart) / 1000, 1));
      if (watcher.appliedPercent() != Math.floor(block.number / remoteCurrentNumber * 100)) {
        watcher.appliedPercent(Math.floor(block.number / remoteCurrentNumber * 100));
      }
      return BlockchainService.submitBlock(block, cautious, constants.FORK_ALLOWED);
    };
  }

  //============
  // Peer
  //============
  function syncPeer (node) {

    // Global sync vars
    var remotePeer = new Peer({});
    var remoteJsonPeer = {};

    return co(function *() {
      let json = yield Q.nfcall(node.network.peering.get);
      remotePeer.copyValuesFrom(json);
      var entry = remotePeer.getRaw();
      var signature = dos2unix(remotePeer.signature);
      // Parameters
      if(!(entry && signature)){
        throw 'Requires a peering entry + signature';
      }

      remoteJsonPeer = json;
      remoteJsonPeer.pubkey = json.pubkey;
      let signatureOK = PeeringService.checkPeerSignature(remoteJsonPeer);
      if (!signatureOK) {
        watcher.writeStatus('Wrong signature for peer #' + remoteJsonPeer.pubkey);
      }
      try {
        yield PeeringService.submitP(remoteJsonPeer);
      } catch (err) {
        if (err != constants.ERROR.PEER.ALREADY_RECORDED && err != constants.ERROR.PEER.UNKNOWN_REFERENCE_BLOCK) {
          throw err;
        }
      }
    });
  }
};

function NodesMerkle (json) {
  
  var that = this;
  ["depth", "nodesCount", "leavesCount"].forEach(function (key) {
    that[key] = json[key];
  });

  this.merkleRoot = json.root;

  // var i = 0;
  // this.levels = [];
  // while(json && json.levels[i]){
  //   this.levels.push(json.levels[i]);
  //   i++;
  // }

  this.root = function () {
    return this.merkleRoot;
  };
}

function MultimeterWatcher() {

  var multi = multimeter(process);
  var charm = multi.charm;
  charm.on('^C', process.exit);
  charm.reset();

  multi.write('Progress:\n\n');

  multi.write("Download: \n");
  var downloadBar = multi("Download: \n".length, 3, {
    width : 20,
    solid : {
      text : '|',
      foreground : 'white',
      background : 'blue'
    },
    empty : { text : ' ' }
  });

  multi.write("Apply:    \n");
  var appliedBar = multi("Apply:    \n".length, 4, {
    width : 20,
    solid : {
      text : '|',
      foreground : 'white',
      background : 'blue'
    },
    empty : { text : ' ' }
  });

  multi.write('\nStatus: ');

  var xPos, yPos;
  charm.position(function (x, y) {
    xPos = x;
    yPos = y;
  });

  var writtens = [];
  this.writeStatus = function(str) {
    writtens.push(str);
    //require('fs').writeFileSync('writtens.json', JSON.stringify(writtens));
    charm
      .position(xPos, yPos)
      .erase('end')
      .write(str)
    ;
  };

  this.downloadPercent = function(pct) {
    return downloadBar.percent(pct);
  };

  this.appliedPercent = function(pct) {
    return appliedBar.percent(pct);
  };

  this.end = function() {
    multi.write('\nAll done.\n');
    multi.destroy();
  };

  downloadBar.percent(0);
  appliedBar.percent(0);
}

function LoggerWatcher() {

  var downPct = 0, appliedPct = 0, lastMsg;

  this.showProgress = function() {
    logger.info('Downloaded %s%, Applied %s%', downPct, appliedPct);
  };

  this.writeStatus = function(str) {
    if (str != lastMsg) {
      lastMsg = str;
      logger.info(str);
    }
  };

  this.downloadPercent = function(pct) {
    if (pct !== undefined) {
      let changed = pct > downPct;
      downPct = pct;
      if (changed) this.showProgress();
    }
    return downPct;
  };

  this.appliedPercent = function(pct) {
    if (pct !== undefined) {
      let changed = pct > appliedPct;
      appliedPct = pct;
      if (changed) this.showProgress();
    }
    return appliedPct;
  };

  this.end = function() {
  };

}

util.inherits(Synchroniser, stream.Duplex);
