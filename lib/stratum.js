var net = require('net');
var events = require('events');

var util = require('./util.js');

var isValidHexRegex = /^[0-9A-Fa-f]+$/;

var SubscriptionCounter = function(){
    var count = 0;
    var padding = 'deadbeefcafebabe';
    return {
        next: function(){
            count++;
            if (Number.MAX_VALUE === count) count = 0;
            return padding + util.packInt64LE(count).toString('hex');
        }
    };
};


/**
 * Defining each client that connects to the stratum server. 
 * Emits:
 *  - subscription(obj, cback(error, extraNonce1, extraNonce2Size))
 *  - submit(data(name, jobID, extraNonce2, ntime, nonce))
 *  - submit(data(name, jobID, extraNonce2, ntime, nonce, verionBit))
**/
var StratumClient = function(options){
    var pendingDifficulty = null;
    //private members
    this.socket = options.socket;

    this.remoteAddress = options.socket.remoteAddress;

    var banning = options.banning;

    var _this = this;

    var emitLog = function (text) { _this.emit('log', 'debug', text); };

    this.lastActivity = Date.now();

    this.shares = {valid: 0, invalid: 0};

    var considerBan = (!banning || !banning.enabled) ? function(){ return false } : function(shareValid){
        if (shareValid === true) _this.shares.valid++;
        else _this.shares.invalid++;
        var totalShares = _this.shares.valid + _this.shares.invalid;
        if (totalShares >= banning.checkThreshold){
            var percentBad = (_this.shares.invalid / totalShares) * 100;
            if (percentBad < banning.invalidPercent) //reset shares
                this.shares = {valid: 0, invalid: 0};
            else {
                _this.emit('triggerBan', _this.shares.invalid + ' out of the last ' + totalShares + ' shares were invalid');
                _this.socket.destroy();
                return true;
            }
        }
        return false;
    };

    this.init = function init(){
        setupSocket();
    };

    function handleMessage(message){
        switch(message.method){
            case 'mining.subscribe':
                emitLog('mining.subscribe message from  miners');
                handleSubscribe(message);
                break;
            case 'mining.authorize':
                emitLog('mining.authorize message from  miner');
                handleAuthorize(message, true /*reply to socket*/);
                break;
            case 'mining.get_multiplier':
                emitLog('mining.get_multiplier message from  miner');
                _this.emit('log', algos[options.coin.algorithm].multiplier);
                sendJson({
                    id: null,
                    result: [algos[options.coin.algorithm].multiplier],
                    method: "mining.get_multiplier"
                });
                break;
            case 'ping':
                emitLog('ping message from  miner');
                _this.lastActivity = Date.now();
                sendJson({
                    id: null,
                    result: [],
                    method: "pong"
                });
                break;
//            case 'mining.configure':
//                emitLog('mining.configure message from  miner');
//                handleConfigure(message);
//                break;
            case 'mining.submit':
                _this.lastActivity = Date.now();
                emitLog('mining.submit message from  miner');
                handleSubmit(message);
                break;
            case 'mining.get_transactions':
                sendJson({
                    id     : null,
                    result : [],
                    error  : true
                });
                emitLog('mining.get_transactionsfrom  miner, message = %s');
                break;
            case 'mining.configure':
 //               console.log("mining.configure message", message);
                handleMiningConfigure(message);
                break;
            case 'mining.multi_version':
//                emitLog('mining.muti_version message');
                handleMiningMultiVersion(message);
                break;
            default:
                _this.emit('unknownStratumMethod', message);
                break;
        }
    }

    function handleSubscribe(message){
        if (! _this._authorized ) {
            _this.requestedSubscriptionBeforeAuth = true;
        }
        _this.emit('subscription',
            {},
            function(error, extraNonce1, extraNonce2Size){
                if (error){
                    sendJson({
                        id: message.id,
                        result: null,
                        error: error
                    });
                    return;
                }
                _this.extraNonce1 = extraNonce1;
                sendJson({
                    id: message.id,
                    result: [
                        [
                            ["mining.set_difficulty", options.subscriptionId],
                            ["mining.notify", options.subscriptionId]
                        ],
                        extraNonce1,
                        extraNonce2Size
                    ],
                    error: null
                });
            }
        );
    }

    function handleAuthorize(message, replyToSocket){
        _this.workerName = message.params[0];
        _this.workerPass = message.params[1];
        options.authorizeFn(_this.remoteAddress, options.socket.localPort, _this.workerName, _this.workerPass, function(result) {
            _this.authorized = (!result.error && result.authorized);
            
            if (replyToSocket) {
                sendJson({
                        id     : message.id,
                        result : _this.authorized,
                        error  : result.error
                    });
            }

            // If the authorizer wants us to close the socket lets do it.
            if (result.disconnect === true) {
                options.socket.destroy();
            }
        });
    }

    function handleSubmit(message){
	//console.log("handleSubmit", message);
        if (!_this.authorized){
            sendJson({
                id    : message.id,
                result: null,
                error : [24, "unauthorized worker", null]
            });
            considerBan(false);
            return;
        }
        if (!_this.extraNonce1){
            sendJson({
                id    : message.id,
                result: null,
                error : [25, "not subscribed", null]
            });
            considerBan(false);
            return;
        }
        var params = {
            name: message.params[0],
            jobId: message.params[1],
            extraNonce2: message.params[2],
            nTime: message.params[3].toLowerCase(),
            //nonce: message.params[4].toLowerCase()
            nonce: message.params[4].toLowerCase(),
	    versionBit  : message.params[5]
        };

        if (options.coin.version_mask && isValidHexRegex.test(options.coin.version_mask) && message.params.length > 5 && isValidHexRegex.test(message.params[5])) {
            var versionMask = parseInt(message.params[5], 16);
            if (versionMask && ((~parseInt(options.coin.version_mask, 16)) & versionMask) !== 0) {
                sendJson({
                    id: message.id,
                    result: null,
                    error: [6, "invalid version mask", null]
                });
                considerBan(false);
                return;
            }
            params.versionMask = versionMask;
        }

        _this.emit('submit', params,
            function(error, result){
                if (!considerBan(result)){
                    sendJson({
                        id: message.id,
                        result: result,
                        error: error
                    });
                }
            }
        );
    }

    function handleConfigure(message) {
        if (options.coin.version_mask && isValidHexRegex.test(options.coin.version_mask)) {
            sendJson({
                id: message.id,
                result: {
                    'version-rolling': true,
                    'version-rolling.mask': options.coin.version_mask
                },
                error: null
            });
        } else {
            _this.emit('unknownStratumMethod', message);
        } 
    }

    function sendJson(){
        var response = '';
        for (var i = 0; i < arguments.length; i++){
            response += JSON.stringify(arguments[i]) + '\n';
        }
        options.socket.write(response);
    }

    function setupSocket(){
        var socket = options.socket;
        var dataBuffer = '';
        socket.setEncoding('utf8');

        if (options.tcpProxyProtocol === true) {
            socket.once('data', function (d) {
                if (d.indexOf('PROXY') === 0) {
                    _this.remoteAddress = d.split(' ')[2];
                }
                else{
                    _this.emit('tcpProxyError', d);
                }
                _this.emit('checkBan');
            });
        }
        else{
            _this.emit('checkBan');
        }
        socket.on('data', function(d){
            dataBuffer += d;
            if (Buffer.byteLength(dataBuffer, 'utf8') > 10240){ //10KB
                dataBuffer = '';
                _this.emit('socketFlooded');
                socket.destroy();
                return;
            }
            if (dataBuffer.indexOf('\n') !== -1){
                var messages = dataBuffer.split('\n');
                var incomplete = dataBuffer.slice(-1) === '\n' ? '' : messages.pop();
                messages.forEach(function(message){
                    if (message === '') return;
                    var messageJson;
                    try {
                        messageJson = JSON.parse(message);
                    } catch(e) {
                        if (options.tcpProxyProtocol !== true || d.indexOf('PROXY') !== 0){
                            _this.emit('malformedMessage', message);
                            socket.destroy();
                        }
                        return;
                    }

                    if (messageJson) {
                        handleMessage(messageJson);
                    }
                });
                dataBuffer = incomplete;
            }
        });
        socket.on('close', function() {
            _this.emit('socketDisconnect');
        });
        socket.on('error', function(err){
            if (err.code !== 'ECONNRESET')
                _this.emit('socketError', err);
        });
    }

    function handleMiningMultiVersion(message){
        var mVersion = parseInt(message.params[0]);
        if (mVersion == 1) {
            _this.asicBoost = false;
	        _this.versionMask = "00000000";
        } else if (mVersion > 1) {  // like 4
            _this.asicBoost = true;
	        _this.versionMask = "1fffe000";    // default mask
        }
        console.log("multiVersion:", _this.asicBoost);
        return true
    }

    function handleMiningConfigure(message){
//        console.log("handleMiningConfigure", message)
        if (options.multiVersion == false ) {
            sendJson({
                error : null,
                id : message.id,
                reseult: {
                    "version-rolling": false
		        }
            });
            _this.asicBoost = false;
            _this.versionMask = "00000000";
	        console.log("support asicBoost", _this.asicBoost, "versionMask", _this.versionMask);
            return true
        }

        //[ [ 'version-rolling' ],{ 'version-rolling.mask': 'ffffffff' } ] }
        // Look like no one(popular miner) follows standards, so we skip interaction at this time. https://github.com/slushpool/stratumprotocol/blob/master/stratum-extensions.mediawiki
//        console.log("mining.confiure params ...", " version-rolling", message.params[0], " mask:", message.params[1])
        //if (message.params[0] != "version-rolling") {
        //    console.log("missing madantary field of version-rolling")
        //    return true
        //}
        sendJson({
            error: null,
            id: message.id,
            result: {
                "version-rolling": true,
                "version-rolling.mask": "1fffe000"    
	    }    
        });
        _this.asicBoost = true;
	    _this.versionMask = "1fffe000";

        return true
    }

    this.getLabel = function(){
        return (_this.workerName || '(unauthorized)') + ' [' + _this.remoteAddress + ']';
    };

    this.enqueueNextDifficulty = function(requestedNewDifficulty) {
        pendingDifficulty = requestedNewDifficulty;
        return true;
    };

    //public members

    /**
     * IF the given difficulty is valid and new it'll send it to the client.
     * returns boolean
     **/
    this.sendDifficulty = function(difficulty){
        if (difficulty === this.difficulty)
            return false;

        _this.previousDifficulty = _this.difficulty;
        _this.difficulty = difficulty;
        sendJson({
            id    : null,
            method: "mining.set_difficulty",
            params: [difficulty]//[512],
        });
        return true;
    };

    this.sendMiningJob = function (jobParams, odoKey) {

        var lastActivityAgo = Date.now() - _this.lastActivity;
        if (lastActivityAgo > options.connectionTimeout * 1000) {
            _this.emit('socketTimeout', 'last submitted a share was ' + (lastActivityAgo / 1000 | 0) + ' seconds ago');
            _this.socket.destroy();
            return;
        }
        if (pendingDifficulty !== null) {
            var result = _this.sendDifficulty(pendingDifficulty);
            pendingDifficulty = null;
            if (result) {
                _this.emit('difficultyChanged', _this.difficulty);
            }
        }
            var json = {
                id: null,
                method: "mining.notify",
                params: jobParams
    };

    if (odoKey !== null) {
        json.odokey = odoKey;
    }

    sendJson(json);
};

    this.manuallyAuthClient = function (username, password) {
        handleAuthorize({id: 1, params: [username, password]}, false /*do not reply to miner*/);
    };

    this.manuallySetValues = function (otherClient) {
        _this.extraNonce1        = otherClient.extraNonce1;
        _this.previousDifficulty = otherClient.previousDifficulty;
        _this.difficulty         = otherClient.difficulty;
        _this.asicBoost          = otherClient.asicBoost;
        _this.versionMask        = otherClient.versionMask;
    };
};
StratumClient.prototype.__proto__ = events.EventEmitter.prototype;




/**
 * The actual stratum server.
 * It emits the following Events:
 *   - 'client.connected'(StratumClientInstance) - when a new miner connects
 *   - 'client.disconnected'(StratumClientInstance) - when a miner disconnects. Be aware that the socket cannot be used anymore.
 *   - 'started' - when the server is up and running
 **/
var StratumServer = exports.Server = function StratumServer(options, authorizeFn){

    //private members

    //ports, connectionTimeout, jobRebroadcastTimeout, banning, haproxy, authorizeFn

    var bannedMS = options.banning ? options.banning.time * 1000 : null;

    var _this = this;
    var stratumClients = {};
    var subscriptionCounter = SubscriptionCounter();
    var rebroadcastTimeout;
    var bannedIPs = {};


    function checkBan(client){
        if (options.banning && options.banning.enabled && client.remoteAddress in bannedIPs){
            var bannedTime = bannedIPs[client.remoteAddress];
            var bannedTimeAgo = Date.now() - bannedTime;
            var timeLeft = bannedMS - bannedTimeAgo;
            if (timeLeft > 0){
                client.socket.destroy();
                client.emit('kickedBannedIP', timeLeft / 1000 | 0);
            }
            else {
                delete bannedIPs[client.remoteAddress];
                client.emit('forgaveBannedIP');
            }
        }
    }

    this.handleNewClient = function (socket){

        socket.setKeepAlive(true);
        var subscriptionId = subscriptionCounter.next();
        var client = new StratumClient(
            {
                subscriptionId: subscriptionId,
                authorizeFn: authorizeFn,
                socket: socket,
                banning: options.banning,
                connectionTimeout: options.connectionTimeout,
                tcpProxyProtocol: options.tcpProxyProtocol,
                coin: options.coin
            }
        );

        stratumClients[subscriptionId] = client;
        _this.emit('client.connected', client);
        client.on('socketDisconnect', function() {
            _this.removeStratumClientBySubId(subscriptionId);
            _this.emit('client.disconnected', client);
        }).on('checkBan', function(){
            checkBan(client);
        }).on('triggerBan', function(){
            _this.addBannedIP(client.remoteAddress);
        }).init();
        return subscriptionId;
    };


    this.broadcastMiningJobs = function (jobParams, odoKey){
        for (var clientId in stratumClients) {
            var client = stratumClients[clientId];
            client.sendMiningJob(jobParams, odoKey);
        }
        /* Some miners will consider the pool dead if it doesn't receive a job for around a minute.
           So every time we broadcast jobs, set a timeout to rebroadcast in X seconds unless cleared. */
        clearTimeout(rebroadcastTimeout);
        rebroadcastTimeout = setTimeout(function(){
            _this.emit('broadcastTimeout');
        }, options.jobRebroadcastTimeout * 1000);
    };



    (function init(){

        //Interval to look through bannedIPs for old bans and remove them in order to prevent a memory leak
        if (options.banning && options.banning.enabled){
            setInterval(function(){
                for (ip in bannedIPs){
                    var banTime = bannedIPs[ip];
                    if (Date.now() - banTime > options.banning.time)
                        delete bannedIPs[ip];
                }
            }, 1000 * options.banning.purgeInterval);
        }


        //SetupBroadcasting();


        var serversStarted = 0;
        Object.keys(options.ports).forEach(function(port){
            net.createServer({allowHalfOpen: false}, function(socket) {
                _this.handleNewClient(socket);
            }).listen(parseInt(port), function() {
                serversStarted++;
                if (serversStarted == Object.keys(options.ports).length)
                    _this.emit('started');
            });
        });
    })();


    //public members

    this.addBannedIP = function(ipAddress){
        bannedIPs[ipAddress] = Date.now();
        /*for (var c in stratumClients){
            var client = stratumClients[c];
            if (client.remoteAddress === ipAddress){
                _this.emit('bootedBannedWorker');
            }
        }*/
    };

    this.getStratumClients = function () {
        return stratumClients;
    };

    this.removeStratumClientBySubId = function (subscriptionId) {
        delete stratumClients[subscriptionId];
    };

    this.manuallyAddStratumClient = function(clientObj) {
        var subId = _this.handleNewClient(clientObj.socket);
        if (subId != null) { // not banned!
            stratumClients[subId].manuallyAuthClient(clientObj.workerName, clientObj.workerPass);
            stratumClients[subId].manuallySetValues(clientObj);
        }
    };

};
StratumServer.prototype.__proto__ = events.EventEmitter.prototype;
