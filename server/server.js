/**
 * Important note: this application is not suitable for benchmarks!
 */

var http = require('http')
  , url = require('url')
  , fs = require('fs')
  , io = require('socket.io')
  , sys = require(process.binding('natives').util ? 'util' : 'sys')
  , sqlite3 = require('sqlite3')
  , server;

require('joose');
require('joosex-namespace-depended');
var Cookies = require('cookies');
var hash = require('hash');


var dom = {};
dom.game = require('./game/game').game;

var db = new sqlite3.Database('storage.db3');

var games = {};
var gamesByPlayer = {};

server = http.createServer(function(req, res){
  var cookies = new Cookies(req, res);
  // your normal server code
  var path = url.parse(req.url).pathname;
  switch (path){
    case '/':
	  if(checkAuth(req, cookies)) {
		  sendFile(res, '/menu.html');
	  } else {
		  sendFile(res, '/login.html');
	  }
      break;
      
	case '/login':
  	    // process: get params, check they exist. check DB. reject page or accept. on accept, generate opaque uid cookie via salt+SHA1, set cookie, redirect to /dominion.html
  	    var query = url.parse(req.url, true).query;
  	    if(!query || !query.email || !query.dompwd) { // improper request
  	        sendRedirect(res, '/login.html');
  	        break;
  	    }
  
  	    var hashedpwd = Hash.sha256(query.dompwd);
  	    var sql = db.get('SELECT * FROM User WHERE email = ? AND password = ? LIMIT 1', { 1: query.email, 2: hashedpwd }, function(err, row) {
  		    if(err || !res) { // query failed
  		        sendRedirect(res, '/login.html');
  		        return;
  		    }

            cookies.set('email', query.email);
            cookies.set('uid', buildUid(query.email, req));

            sendRedirect(res, '/');
        });
        break;

    case '/host':
        // process: get params, check valid, check existence of game. create game, create entry for it, add new player, redirect to game lobby.
        if(!checkAuth(req, cookies)) {
            send404(res);
            break;
        }

        var query = url.parse(req.url, true).query;
        if(!query || !query.name) {
            sendError(res, '/', 'You must supply a game name.');
            break;
        }

        var email = cookies.get('email'); // safe because of checkAuth
        if(gamesByPlayer[email]) {
            sendRedirect(res, '/game');
            break;
        }

        if(games[query.name]) {
            sendError(res, '/', 'A game with that name already exists.');
            break;
        }

        // after all that, we're free to create a game
        games[query.name] = new dom.game();
        // the player will be added once the socket is connected
        gamesByPlayer[email] = query.name;

        sendRedirect(res, '/game');
        break;

    case '/join':
        // process: get params, check valid, check existence of game and gamesByPlayer entry. redirect player to game.
        if(!checkAuth(req, cookies)) {
            send404(res);
            break;
        }

        var query = url.parse(req.url, true).query;
        if(!query || !query.name) {
            sendError(res, '/', 'You must supply a game name.');
            break;
        }

        var email = cookies.get('email'); // safe because of checkAuth
        if(gamesByPlayer[email]) {
            sendRedirect(res, '/game');
            break;
        }

        if(!games[query.name]) {
            sendError(res, '/', 'No game with that name exists.');
            break;
        }

        // otherwise add the player to the game
        gamesByPlayer[email] = query.name;

        sendRedirect(res, '/game');
        break;

    case '/game':
        if(!checkAuth(req, cookies)) {
            sendRedirect(res, '/');
            break;
        }

        var email = cookies.get('email'); // safe
        if(!gamesByPlayer[email]) {
            sendRedirect(res, '/');
            break;
        }

        sendFile(res, '/dominion.html');
        break;

    default: send404(res);
  }
}),

send404 = function(res){
  res.writeHead(404);
  res.write('404');
  res.end();
};

sendRedirect = function(res, to) {
	res.writeHead('303', 'Login redirect', { 'Location': to, 'Content-type': 'text/html' });
	res.write('<html><body>Redirecting to <a href="' + to + '">here</a>...</body></html>');
	res.end();
};

buildUid = function(email, req) {
    return Hash.sha256(email + 'a salt value' + req.connection.remoteAddress + ' Dominion v0.1 by Braden Shepherdson');
};

checkAuth = function(req, cookies) {
    var email = cookies.get('email');
    var uid = cookies.get('uid');
    if(!email || !uid) {
        return false;
    }

    return uid == buildUid(email, req);
};

sendError = function(res, link, message) {
    res.write('<html><body>' + message + '<br /><a href="' + link + '">Go back</a></body></html>');
    res.end();
};

server.listen(8080);

// socket.io, I choose you
// simplest chat application evar
var io = io.listen(server);
  
var thegame = new dom.game();

io.on('connection', function(client){
  var player = thegame.addPlayer(client);
  client.broadcast({ announcement: client.sessionId + ' connected' });
  
  client.on('message', function(message){
	if('chat' in message) {
		if(message.chat[0] == '/') {
			var match = /^\/(\S+?)\b/.exec(message.chat);
			command(client, match[1], message.chat);
		} else {
			var msg = { message: [client.sessionId, message] };
			client.broadcast(msg);
		}
	} else if('decision' in message) {
		if(player.handlers.length > 0) {
			var h = player.handlers[0];
			if(h(player, message.decision)) {
				player.handlers.shift();
			} else {
				client.send({ retry: 1 });
			}
		}
	}
  });

  client.on('disconnect', function(){
    client.broadcast({ announcement: client.sessionId + ' disconnected' });
  });

  // DEBUG
  if(thegame.players.length == 2) {
	  thegame.startGame();
  }
});


function command(c, cmd, msg) {
	if(cmd == 'whisper') {
		var split = firstRestSplit(msg);
		var target = clients[split.first];
		if(target) {
			target.send({ whisper: [ c.sessionId, split.rest ] });
		} else {
			c.send({ message: [ 'System', 'No such user ' + split.first]});
		}
	}

	else {
		c.send({ message: [ 'System', 'No such command \'' + cmd + '\'' ]});
	}
}

function firstRestSplit(s) {
	var match = /^\/.*?\s+(\S+)\s+(.*)$/.exec(s);
	return { first: match[1], rest: match[2] };
}


function sendFile(res, path) {
    fs.readFile(__dirname + path, function(err, data){
        if (err) return send404(res);
        res.writeHead(200, {'Content-Type': path == 'json.js' ? 'text/javascript' : 'text/html'})
        res.write(data, 'utf8');
        res.end();
    });
}

