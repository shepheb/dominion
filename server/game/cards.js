
// some general thoughts on cards
// * there are a number of crossover cards that are multiple types. May as well plan for that now.
//   * for cards that name a specific type they apply to, a mixed card counts as either type.
//   * so the types are a set rather than a scalar
//   * types: Victory, Treasure, Action, Attack, Reaction, Curse, (Duration (not in Base))
// * each player has a hand, deck, discards. the board has the kingdom, victory and curse cards. coins are not counted, since they're infinite.
// * it can be a player's turn, or players can have decisions to make. the game state includes a queue (stack?) of decisions to be made.
//   * does a decision always consist of choosing (a) card(s)? No, there are also "may" instructions on cards.
// * how to represent the rules? There are some basic patterns: + Cards, Actions, Buys and Coin.
//   * then I think there's three kinds of ones implemented as functions on players: me, everyone, everyone but me.
//   * those functions transform the player state in some way mid-turn. I need to think how that interacts with the API model and asking questions of the user.
//   * maybe anywhere in the JS code I can define a callback and say "ask this user this question, and hit this code with his response."
//     * I think that's a workable, nicely JSful approach.

var dom = {};
dom.cards = {};

dom.Decision = require('./decision').Decision;
dom.Option = require('./decision').Option;
dom.utils = require('./utils');

dom.card = function(name, types, cost, text, rules) {
	this.name = name;
	this.types = types;
	this.cost = cost;
	this.text = text;
	this.rules = rules;
};


// common card rules
rules = {};
function basicRule(field) {
	return function(amount) {
		return function(p,c) { p[field] += amount; c(); };
	};
}

/** @param {number} */
rules.plusCoin = function(amount) {
	return function(p,c) {
		p.coin += amount;
		p.logMe('gains +' + amount + ' Coin.');
		if(c) c();
	};
};
/** @param {number} */
rules.plusBuys = function(amount) {
	return function(p,c) {
		p.buys += amount;
		p.logMe('gains +' + amount + ' Buy' + (amount > 1 ? 's' : '') + '.');
		if(c) c();
	};
};
/** @param {number} */
rules.plusActions = function(amount) {
	return function(p,c) {
		p.actions += amount;
		p.logMe('gains +' + amount + ' Action' + (amount > 1 ? 's' : '') + '.');
		if(c) c();
	};
};
/** @param {number} */
rules.plusCards = function(amount) {
	return function(p,c) {
		for(var i=0; i < amount; i++) {
			p.draw();
		}
		p.logMe('draws ' + amount + ' card' + (amount > 1 ? 's' : '') + '.');
		if(c) c();
	};
};
rules.nullRule = function(p, c) { c(); };


rules.discardMany = function(callback) {
	var internal = function(p, c) {
		if(!p.temp.discarded) {
			p.temp.discarded = [];
		}

		var opts = dom.utils.cardsToOptions(p.hand_);
		opts.push(new dom.Option('done', 'Done discarding'));
		var dec = new dom.Decision(p, opts, 'Choose the next card to discard, or stop discarding.', []);
		p.game_.decision(dec, dom.utils.decisionHelper(function() {
			var discarded = p.temp.discarded;
			p.temp.discarded = [];
			callback(p, c, discarded);
		}, function(index) {
			var card = p.discard(index);
			p.temp.discarded.push(card);
			internal(p, c);
		}, function() {
			internal(p, c);
		}));
	};

	return internal;
};


rules.gainCard = function(name, f) {
	return function(p,c) {
		var inKingdom;
		for(var i = 0; i < p.game_.kingdom.length; i++) {
			if(p.game_.kingdom[i].card.name == name) {
				inKingdom = p.game_.kingdom[i];
				break;
			}
		}

		if(!inKingdom || inKingdom.count <= 0) {
			c(); // fail to gain the card
		} else {
			f(p, inKingdom.card);
			inKingdom.count--;
			c();
		}
	};
};

rules.yesNo = function(message, yes, no) {
	return function(p, c) {
		var opts = [
			new dom.Option('yes', 'Yes'),
			new dom.Option('no', 'No')
		];
		var dec = new dom.Decision(p, opts, message, []);
		p.game_.decision(dec, function(key) {
			if(key == 'yes') {
				yes(p, c);
			} else {
				no(p, c);
			}
		});
	};
};


rules.maybe = function(pred, when) {
	return function(p,c) {
		if(pred(p)) {
			when(p,c);
		} else {
			c();
		}
	};
};

// f has type (player whose turn it is, target player, continuation)

rules.everyOtherPlayer = function(inParallel, isAttack, f) {
	return rules.everyPlayer(false, inParallel, isAttack, f);
};

rules.everyPlayer = function(includeMe, inParallel, isAttack, f) {
	if(inParallel) {
		return function(p, c) {
			var sent = 0;
			var completed = 0;
			var doneSending = false;
            var reactionsOutstanding = 0;

			var cont = function() {
				completed++;
				if(doneSending && reactionsOutstanding == 0 && completed >= sent) {
					c();
				}
			};

            var handleAction = function(o) {
                var savedBy = o.safeFromAttack();
                if((includeMe && p.id_ == o.id_)
                || (p.id_ != o.id_ && 
                     (!isAttack || !savedBy))){
                    sent++;
                    f(p, o, cont);
                } else if(isAttack && savedBy) {
                    o.logMe('is protected by ' + savedBy + '.');
                }
            };

			for(var i = 0; i < p.game_.players.length; i++) {
                var wrapper = function() {
                    var o = p.game_.players[i];
                    var reactions = o.hand_.filter(function(x) { return x.types['Reaction']; });
                    if(((includeMe && p.id_ == o.id_) || p.id_ != o.id_) && isAttack && reactions.length) {
                        reactionsOutstanding += reactions.length;

                        var len = reactions.length;

                        var reactionCont = function(index) {
                            return function() {
                                reactionsOutstanding--;
                                if(index >= len) {
                                    handleAction(o);
                                } else {
                                    reactions[index].reactionRule(o, reactionCont(index+1));
                                }
                            };
                        };

                        reactions[0].reactionRule(o, reactionCont(1));
                    } else {
                        handleAction(p.game_.players[i]);
                    }
                };
                wrapper();
			}

			doneSending = true;
			if(reactionsOutstanding == 0 && completed >= sent) {
				c(); // they've all returned already
			}

			// otherwise I just return and wait for the continuations to do their thing.
		};
	} else {
		return function(p, c) {
			var repeat = function(index) {
				if(index >= p.game_.players.length) {
					c();
					return;
				}

				if(!includeMe && p.game_.players[index].id_ == p.id_) {
					repeat(index+1);
					return;
				}

                var reactionOutstanding = 0;

                var handleAction = function(o) {
                    var savedBy = o.safeFromAttack();
                    if(isAttack && savedBy) {
                        o.logMe('is protected by ' + savedBy + '.');
                        repeat(index+1);
                    } else {
                        f(p, o, function() {
                            actionComplete = true;
                            repeat(index+1);
                        });
                    }
                };

                var reactionCont = function() {
                    reactionsOutstanding--;

                    if(reactionsOutstanding == 0) {
                        handleAction(p.game_.players[index]);
                    }
                };


                var reactions = p.game_.players[index].hand_.filter(function(x) { return x.types['Reaction']; });
                if(isAttack && reactions.length) {
                    reactionOutstanding = reactions.length;
                    for(var j = 0; j < reactions.length; j++) {
                        reactions[j].reactionRule(p.game_.players[index], reactionCont);
                    }
                } else {
                    handleAction(p.game_.players[index]);
                }
			};

			repeat(0);
		};
	}
};


// trying to work out the process.
// 1. rule needs to ask a user something and make a decision on the result.
// 2. it calls a framework function with the Option array and a callback.
// 3. framework function returns that data to the user.
// 4. player's response arrives as a new request to the server.
// 5. the callback provided is called with the result.
// 6. the callback will either ask more questions or call a continuation when it's done.
// 7. that continuation ends up back in the player's turn, signaling the end of that rule.
// - the player object keeps track of the turn state: working its way through the rules on each card, the phases of the turn and so on.

// first the common cards
dom.cards['Gold']   = new dom.card('Gold',   { 'Treasure': 1 }, 6, '', rules.plusCoin(3));
dom.cards['Silver'] = new dom.card('Silver', { 'Treasure': 1 }, 3, '', rules.plusCoin(2));
dom.cards['Copper'] = new dom.card('Copper', { 'Treasure': 1 }, 0, '', rules.plusCoin(1));

dom.cards['Province'] = new dom.card('Province', { 'Victory': 1 }, 8, '', rules.nullRule);
dom.cards['Duchy']    = new dom.card('Duchy',    { 'Victory': 1 }, 5, '', rules.nullRule);
dom.cards['Estate']   = new dom.card('Estate',   { 'Victory': 1 }, 2, '', rules.nullRule);
dom.cards['Curse']    = new dom.card('Curse',    { 'Curse': 1 },   0, '', rules.nullRule);


// and now the kingdom cards
dom.cards['Cellar'] = new dom.card('Cellar', { 'Action': 1 }, 2, '+1 Action. Discard any number of cards. +1 Card per card discarded.', [
	rules.plusActions(1),
	rules.discardMany(function(p, c, discarded) {
		p.logMe('draws ' + discarded.length + ' card' + (discarded.length == 1 ? '' : 's') + '.');
		p.draw(discarded.length);
		c();
	})
]);

dom.cards['Chapel'] = new dom.card('Chapel', { 'Action': 1 }, 2, 'Trash up to 4 cards from your hand.', [
    function(p, c) {
        var repeat = function(count) {
            if(count >= 4) {
                c();
                return;
            }

            dom.utils.handDecision(p, 'Choose a card to trash.', 'Done trashing', dom.utils.const(true), function(index) {
                var card = p.hand_[index];
                p.logMe('trashes ' + card.name + '.');
                p.removeFromHand(index);
                repeat(count+1);
            }, c);
        };

        repeat(0);
    }
]);


dom.cards['Chancellor'] = new dom.card('Chancellor', { 'Action': 1}, 3, '+2 Coins. You may immediately put your deck into your discard pile.', [
	rules.plusCoin(2),
	rules.yesNo('Do you want to move your deck to your discard pile?', function(p, c) {
		dom.utils.append(p.discards_, p.deck_);
		p.deck_ = [];
		p.logMe('moves their deck to their discard pile.');
        c();
	}, function(p, c) { c(); })
]);

dom.cards['Village'] = new dom.card('Village', { 'Action': 1 }, 3, '+1 Card. +2 Actions.', [ rules.plusCards(1), rules.plusActions(2) ]);

dom.cards['Woodcutter'] = new dom.card('Woodcutter', { 'Action': 1 }, 3, '+1 Buy. +2 Coin.', [ rules.plusBuys(1), rules.plusCoin(2) ]);

//dom.cards['Workshop'] = new dom.card('Workshop', { 'Action': 1 }, 3, 


dom.cards['Gardens'] = new dom.card('Gardens', { 'Victory': 1 }, 4, 'Worth 1 Victory for every 10 cards in your deck (rounded down).', []);

dom.cards['Moneylender'] = new dom.card('Moneylender', { 'Action': 1 }, 4, 'Trash a Copper from your hand. If you do, +3 Coin.', [
	rules.maybe(function(p) {
		for(var i = 0; i < p.hand_.length; i++) {
			if(p.hand_[i].name == 'Copper') {
				return true;
			}
		}
		return false;
	}, rules.yesNo('Do you want to trash a Copper for +3 Coin?', function(p, c) {
		for(var i = 0; i < p.hand_.length; i++) {
			if(p.hand_[i].name == 'Copper') {
				p.logMe('trashes a Copper for +3 Coin.');
				p.removeFromHand(i);
				p.coin += 3;
				break;
			}
		}
        c();
	}, function(p, c){ c(); }))
]);

dom.cards['Workshop'] = new dom.card('Workshop', { 'Action': 1 }, 3, 'Gain a card costing up to 4 Coin.', [
	function(p, c) {
		dom.utils.gainCardDecision(p, 'Gain a card costing up to 4 Coin', 'Gain nothing', [], function(card) { return p.game_.cardCost(card) <= 4; },
			function(repeat) { 
				return dom.utils.decisionHelper(
					function() {
						p.logMe('chooses to gain nothing.');
						c();
					},
					function(index) {
						p.buyCard(index, true);
						c();
					}, repeat);
			});
	}]);

dom.cards['Bureaucrat'] = new dom.card('Bureaucrat', { 'Action': 1, 'Attack': 1 }, 4, 'Gain a Silver card; put it on top of your deck. Each other player reveals a Victory card from his hand and puts it on his deck (or reveals a hand with no Victory cards).', [
	rules.gainCard('Silver', function(p,card) { p.deck_.push(card); }),
	rules.everyOtherPlayer(true, true, function(active, p, c) {
		var victoryCards = p.hand_.filter(function(card) { return card.types['Victory']; });
		if(victoryCards.length == 0) {
			var names = [];
			for(var i = 0; i < p.hand_.length; i++) {
				names.push(p.hand_[i].name);
			}
			p.logMe('reveals a hand with no Victory cards: ' + names.join(', '));
			c();
		} else if(victoryCards.length == 1) {
			p.logMe('puts a ' + victoryCards[0].name + ' from their hand on top of their deck.');
			for(var i = 0; i < p.hand_.length; i++) {
				if(p.hand_[i].types['Victory']) {
					var card = p.hand_[i];
					p.removeFromHand(i);
					p.deck_.push(card); // on top
					break;
				}
			}
			c();
		} else {
			// check if there are actually different kinds of Victory cards. Only need to ask if there's variety.
			var types = {};
			var numTypes = 0;
			for(var i = 0; i < victoryCards.length; i++) {
				if(!types[victoryCards[i].name]) {
					numTypes++;
				}
				types[victoryCards[i].name] = 1;
			}

			if(numTypes > 1) {
				// have to ask that player to decide which one to discard
				console.log('Asking Player ' + p.id_ + ' for a decision.');
				dom.utils.handDecision(p, 'Player ' + active.id_ + ' has played a Bureaucrat. Choose a Victory card from your hand to put on top of your deck.', null,
					function(c) { return c.types['Victory']; },
					function(index) {
						var card = p.hand_[index];
						p.logMe('puts a ' + card.name + ' from their hand on top of their deck.');
						p.removeFromHand(index);
						p.deck_.push(card);
						c();
					}, c);
			} else {
				p.logMe('puts a ' + victoryCards[0].name + ' from their hand on top of their deck.');
				for(var i = 0; i < p.hand_.length; i++) {
					if(p.hand_[i].types['Victory']) {
						var card = p.hand_[i];
						p.removeFromHand(i);
						p.deck_.push(card); // on top
						break;
					}
				}
				c();
			}
		}
	})
]);

dom.cards['Feast'] = new dom.card('Feast', { 'Action': 1 }, 4, 'Trash this card. Gain a card costing up to 5 Coin.', [
	function(p,c) {
		var card = p.inPlay_[p.inPlay_.length-1];
		if(card.name == 'Feast') {
			p.logMe('trashes Feast.');
			p.inPlay_.pop();
		} else {
			p.logMe('is unable to trash Feast.');
		}
		c();
	},
	function(p,c) {
		dom.utils.gainCardDecision(p, 'Gain a card costing up to 5 Coin', 'Gain nothing', [], function(card) { return p.game_.cardCost(card) <= 5; },
			function(repeat) {
				return dom.utils.decisionHelper(
					function() { c(); },
					function(index) {
						p.buyCard(index, true);
						c();
					}, repeat);
			});
	}]);

dom.cards['Moat'] = new dom.card('Moat', { 'Action': 1, 'Reaction': 1 }, 2, '+2 Cards. When another player plays an Attack card, you may reveal this from your hand. If you do, you are unaffected by that Attack.', [
	rules.plusCards(2)
]);
dom.cards['Moat'].reactionRule = dom.utils.nullFunction; // Moat's reaction rules are handled separately in the everyPlayer code.

dom.cards['Militia'] = new dom.card('Militia', { 'Action': 1, 'Attack': 1 }, 4, '+2 Coin. Each other player discards down to 3 cards in his hand.', [
	rules.plusCoin(2),
	rules.everyOtherPlayer(true, true, function(active, p, c) {
		var repeat = function() {
			if(p.hand_.length <= 3) {
				c();
				return;
			}

			dom.utils.handDecision(p, 'Player ' + active.id_ + ' has played Militia. Discard down to 3 cards in your hand.', null, dom.utils.const(true),
				function(index) {
					p.discard(index);
					repeat();
				}, null);
		};

		repeat();
	})
]);

dom.cards['Remodel'] = new dom.card('Remodel', { 'Action': 1 }, 4, 'Trash a card from your hand. Gain a card costing up to 2 Coins more than the trashed card.', [
	function(p, c) {
		dom.utils.handDecision(p, 'Choose a card to trash for Remodel.', 'Do not trash anything (and gain no card).', dom.utils.const(true),
			function(index) {
				var card = p.hand_[index];
				p.logMe('trashes ' + card.name + '.');
				p.removeFromHand(index);
				var maxCost = p.game_.cardCost(card) + 2;

				dom.utils.gainCardDecision(p, 'Choose a card to gain (max value ' + maxCost + ')', 'Do not gain anything.', [], function(c){ return p.game_.cardCost(c) <= maxCost; },
					function(repeat) {
						return dom.utils.decisionHelper(
							function() {
								p.logMe('chooses to gain nothing.');
								c();
							},
							function(index) {
								p.buyCard(index, true);
								c();
							},
							repeat);
					});
			}, c);
	}
]);

dom.cards['Smithy'] = new dom.card('Smithy', { 'Action': 1 }, 4, '+3 Cards.', [ rules.plusCards(3) ]);

dom.cards['Spy'] = new dom.card('Spy', { 'Action': 1, 'Attack': 1 }, 4, '+1 Card, +1 Action. Each player (including you) reveals the top card of his deck and either discards it or puts it back, your choice.', [
	rules.plusCards(1),
	rules.plusActions(1),
	rules.everyPlayer(true, false, true, function(active, p, c) {
		var options = [
			new dom.Option('back', 'Put it back on the deck'),
			new dom.Option('discard', 'Discard it')
		];

		if(p.deck_.length == 0) {
			p.shuffleDiscards_();
		}
		var card = p.deck_.pop();
		p.logMe('reveals ' + card.name + '.');
		var isMe = active.id_ == p.id_;
		var dec = new dom.Decision(active, options, (isMe ? 'You' : 'Player ' + p.id_) + ' had a ' + card.name + ' on top of ' + (isMe ? 'your' : 'his') + ' deck.', []);
		p.game_.decision(dec, function(key) {
			if(key == 'back') {
				p.deck_.push(card);
				active.logMe('chooses to put it back.');
			} else {
				p.discards_.push(card);
				active.logMe('chooses to discard it.');
			}
			c();
		});
	})
]);

dom.cards['Thief'] = new dom.card('Thief', { 'Action': 1, 'Attack': 1 }, 4, 'Each other player reveals the top 2 cards of his deck. If they revealed any Treasure cards, they trash one of them that you choose. You may gain any or all of these trashed cards. They discard the other revealed cards.', [
	rules.everyOtherPlayer(true, false, function(active, p, c) {
		if(p.deck_.length == 0){
			p.shuffleDiscards_();
		}
		var cards = [];
		cards.push(p.deck_.pop());
		if(p.deck_.length == 0) {
			p.shuffleDiscards_();
		}
		cards.push(p.deck_.pop());

		p.logMe('revealed ' + cards[0].name + ' and ' + cards[1].name + '.');

		var options = [];
		if(cards[0].types['Treasure']) {
			options.push(new dom.Option('trash0', 'Trash ' + cards[0].name));
			options.push(new dom.Option('keep0', 'Take ' + cards[0].name));
		}
		if(cards[1].types['Treasure']) {
			options.push(new dom.Option('trash1', 'Trash ' + cards[1].name));
			options.push(new dom.Option('keep1', 'Take ' + cards[1].name));
		}
		
		if(options.length > 0) {
			var dec = new dom.Decision(active, options, 'Choose what to do with the Player ' + p.id_ + '\'s revealed Treasures.', []);
			active.game_.decision(dec, function(key) {
				if(key == 'trash0') {
					active.logMe('trashes ' + cards[0].name + '.');
					p.discards_.push(cards[1]);
				} else if(key == 'keep0') {
					active.logMe('keeps ' + cards[0].name + '.');
					active.discards_.push(cards[0]);
					p.discards_.push(cards[1]);
				} else if(key == 'trash1') {
					active.logMe('trashes ' + cards[1].name + '.');
					p.discards_.push(cards[0]);
				} else if(key == 'keep1') {
					active.logMe('keeps ' + cards[1].name + '.');
					active.discards_.push(cards[1]);
					p.discards_.push(cards[0]);
				}
				c();
			});
		} else {
			c();
		}
	})
]);


dom.cards['Throne Room'] = new dom.card('Throne Room', { 'Action': 1 }, 4, 'Choose an Action card in your hand. Play it twice.', [
	function(p, c) {
		dom.utils.handDecision(p, 'Choose an Action card from your hand to be played twice.', 'Play nothing', function(card) { return card.types['Action']; },
			function(index) {
				var card = p.hand_[index];
				p.removeFromHand(index);
				p.inPlay_.push(card);

				p.logMe('uses Throne Room on ' + card.name + '.');

				var rulesList;
				if(typeof card.rules == 'object') { // array 
					rulesList = card.rules;
				} else {
					rulesList = [ card.rules ]; // just a function
				}

				if(!rulesList) {
					c();
					return;
				}

				// gotta copy since we're going to consume them
				for(var i = 0; i < rulesList.length; i++) {
					p.rules_.push(rulesList[i]);
				}
				for(var i = 0; i < rulesList.length; i++) {
					p.rules_.push(rulesList[i]);
				}
				c(); // returns to runRules
			}, c);
	}
]);


dom.cards['Council Room'] = new dom.card('Council Room', { 'Action': 1 }, 5, '+4 Cards. +1 Buy. Each other player draws a card.', [
	rules.plusCards(4),
	rules.plusBuys(1),
	rules.everyOtherPlayer(false, true, function(active, p, c) {
		var f = rules.plusCards(1);
		f(p,c);
	})
]);


dom.cards['Festival'] = new dom.card('Festival', { 'Action': 1 }, 5, '+2 Actions. +1 Buy. +2 Coin.', [
	rules.plusActions(2),
	rules.plusBuys(1),
	rules.plusCoin(2)
]);


dom.cards['Laboratory'] = new dom.card('Laboratory', { 'Action': 1 }, 5, '+2 Cards. +1 Action.', [
	rules.plusCards(2),
	rules.plusActions(1)
]);


dom.cards['Library'] = new dom.card('Library', { 'Action': 1 }, 5, 'Draw until you have 7 cards in hand. You may set aside any Action cards drawn this way, as you draw them; discard the set aside cards after you finish drawing.', [
	function(p,c) {
		var repeat = function() {
			if(p.hand_.length >= 7) {
				p.logMe('has 7 cards in hand, done drawing for Library.');
				c();
				return;
			}

			if(p.deck_.length == 0) {
				p.shuffleDiscards_();
			}
			if(p.deck_.length == 0) { // they've run out of cards, so stop trying to draw.
				p.logMe('is out of cards in their deck.');
				c();
				return;
			}

			var card = p.deck_.pop();
			if(card.types['Action']) {
				var options = [
					new dom.Option('take', 'Take into your hand'),
					new dom.Option('discard', 'Discard')
				];

				var dec = new dom.Decision(p, options, 'You drew an Action, ' + card.name + '. You can either draw it into your hand or discard it.', []);
				p.game_.decision(dec, function(key) {
					if(key == 'take') {
						p.logMe('draws a card.');
						p.hand_.push(card);
					} else {
						p.logMe('sets aside ' + card.name + '.');
						p.discards_.push(card);
					}
					repeat();
				});
			} else {
				p.logMe('draws a card.');
				p.hand_.push(card);
				repeat();
			}
		};
		repeat();
	}
]);


dom.cards['Mine'] = new dom.card('Mine', { 'Action': 1 }, 5, 'Trash a Treasure card from your hand. Gain a Treasure card costing up to 3 Coin more; put it into your hand.', [
	function(p,c) {
        var treasures = p.hand_.filter(function(x) { return x.types['Treasure']; });
        if(!treasures.length) {
            p.logMe('has no Treasures to trash.');
            c();
            return;
        }

		dom.utils.handDecision(p, 'Choose a Treasure card from your hand to trash.', null, function(card){ return card.types['Treasure']; },
			function(index) {
				var card = p.hand_[index];
				p.removeFromHand(index);
                var maxCost = p.game_.cardCost(card) + 3;

                dom.utils.gainCardDecision(p, 'Choose a Treasure to gain worth at most ' + maxCost + '.', null, [], function(c) { return p.game_.cardCost(c) <= maxCost; },
                    function(repeat) {
                        return dom.utils.decisionHelper(dom.utils.nullFunction, function(index) {
                            p.buyCard(index, true);
                            p.hand_.push(p.discards_.pop());
                            c();
                        }, repeat);
                    }
                );
            }, c);
    }
]);
                

dom.cards['Market'] = new dom.card('Market', { 'Action': 1 }, 5, '+1 Card, +1 Action, +1 Buy, +1 Coin.', [
	rules.plusCards(1),
	rules.plusActions(1),
	rules.plusBuys(1),
	rules.plusCoin(1)
]);


dom.cards['Witch'] = new dom.card('Witch', { 'Action': 1, 'Attack': 1 }, 5, '+2 Cards. Each other player gains a Curse card.', [
	rules.plusCards(2),
	rules.everyOtherPlayer(true, true, function(active, p, c) {
		p.buyCard(p.game_.indexInKingdom('Curse'), true);
		c();
	})
]);

dom.cards['Adventurer'] = new dom.card('Adventurer', { 'Action': 1 }, 6, 'Reveal cards from your deck until you reveal 2 Treasure cards. Put those Treasure cards in your hand and discard the other revealed cards.', [
	function(p, c) {
		if(p.deck_.length == 0) {
			p.shuffleDiscards_();
		}

		var toGo = 2;
		while(toGo > 0 && p.deck_.length > 0) {
			var card = p.deck_.pop();
			p.logMe('reveals ' + card.name + '.');
			if(card.types['Treasure']) {
				toGo--;
				p.hand_.push(card);
			} else {
				p.discards_.push(card);
			}

			if(p.deck_.length == 0) {
				p.shuffleDiscards_();
			}
		}
		
		p.logMe('is done drawing for Adventurer.');
		c();
	}
]);


// Seaside

dom.cards['Embargo'] = new dom.card('Embargo', { 'Action': 1 }, 2, '+2 Coin. Trash this card. Put an Embargo token on top of a Supply pile. When a player buys a card, he gains a Curse card per Embargo token on that pile.', [
	rules.plusCoin(2),
	function(p,c) {
		if(p.inPlay_.length > 0 && p.inPlay_[p.inPlay_.length-1].name == 'Embargo') {
			p.inPlay_.pop(); // trash
		}

		var options = [];
		for(var i = 0; i < p.game_.kingdom.length; i++) {
			var inKingdom = p.game_.kingdom[i];
			if(inKingdom.count > 0) {
				options.push(new dom.Option('card[' + i + ']', inKingdom.card.name + 
					(inKingdom.embargoTokens ? ' (' + inKingdom.embargoTokens + ' Embargo token' + (inKingdom.embargoTokens > 1 ? 's' : '') + ')' : '')));
			}
		}

		var dec = new dom.Decision(p, options, 'Choose a Supply pile to place an Embargo token on.', []);
		p.game_.decision(dec, dom.utils.decisionHelper(dom.utils.nullFunction, function(index) {
			var inKingdom = p.game_.kingdom[index];
			if(inKingdom.embargoTokens) {
				inKingdom.embargoTokens++;
			} else {
				inKingdom.embargoTokens = 1;
			}

			p.logMe('Embargoes ' + inKingdom.card.name + '. Now ' + inKingdom.embargoTokens + ' Embargo token' + (inKingdom.embargoTokens > 1 ? 's' : '') + ' on that pile.');
			c();
		}, c));
	}
]);


dom.cards['Haven'] = new dom.card('Haven', { 'Action': 1, 'Duration': 1 }, 2, '+1 Card, +1 Action. Set aside a card from your hand face down. At the start of your next turn, put it into your hand.', [
	rules.plusCards(1),
	rules.plusActions(1),
	function(p, c) {
		if(p.hand_.length <= 0) {
			p.logMe('has no cards left to set aside.');
			c();
			return;
		}

		dom.utils.handDecision(p, 'Choose a card from your hand to set aside for next turn.', null, dom.utils.const(true),
			function(index) {
				var card = p.hand_[index];
				if(!p.temp['havenCards']) p.temp['havenCards'] = [];
				p.temp['havenCards'].push(p.hand_[index]);
				p.logMe('sets aside a card.');
				c();
			}, c);

		p.durationRules.push({ name: 'Haven', rules: [ function(p) {
			if(p.temp['havenCards'] && p.temp['havenCards'].length > 0) {
				for(var i = 0; i < p.temp['havenCards'].length; i++) {
					p.hand_.push(p.temp['havenCards'][i]);
				}
				p.logMe('draws ' + p.temp['havenCards'].length + ' card' + (p.temp['havenCards'].length > 1 ? 's' : '') + ' set aside with Haven.');
				p.temp['havenCards'] = [];
			}
		} ]});
	}
]);


dom.cards['Lighthouse'] = new dom.card('Lighthouse', { 'Action': 1, 'Duration': 1 }, 2, '+1 Action, Now and at the start of your next turn: +1 Coin. - While this is in play, when another player plays an Attack card, it doesn\'t affect you.', [
	rules.plusActions(1),
	rules.plusCoin(1),
	function(p, c) {
		p.durationRules.push({ name: 'Lighthouse', rules: [ rules.plusCoin(1) ]});
		c();
	}
]);


dom.cards['Native Village'] = new dom.card('Native Village', { 'Action': 1 }, 2, '+2 Actions. Choose one: Set aside the top card of your deck face down on your Native Village mat; or put all the cards from your mat into your hand. You may look at the cards on your mat at any time; return them to your deck at the end of the game.', [
	rules.plusActions(2),
	function(p, c) {
		// first need to ask what the user wants to do
		var options = [ new dom.Option('setaside', 'Set aside the top card of your deck on your Native Village mat.'),
		                new dom.Option('intohand', 'Put all the cards on your Native Village mat into your hand.') ];

		var dec = new dom.Decision(p, options, 'You have played Native Village. Choose which of its options to take.', []);
		var repeat = function() {
			p.game_.decision(dec, function(key) {
				if(key == 'setaside') {
					p.logMe('sets aside the top card of their deck.');
					if(!p.temp['Native Village mat']) p.temp['Native Village mat'] = [];
					p.draw(); // draws into hand, but deals with the shuffling
					var card = p.hand_.pop();
					p.client.send({ log: ['The top card was ' + card.name + '.' ]});
					p.temp['Native Village mat'].push(card);
					c();
				} else if(key == 'intohand') {
					var mat = p.temp['Native Village mat'];
					p.logMe('puts the ' + mat.length + ' cards from their Native Village mat into their hand.');
					for(var i = 0; i < mat.length; i++) {
						p.hand_.push(mat[i]);
					}

					p.temp['Native Village mat'] = [];
					c();
				} else {
					repeat();
				}
			});
		};

		repeat();
	}
]);


dom.cards['Pearl Diver'] = new dom.card('Pearl Diver', { 'Action': 1 }, 2, '+1 Card, +1 Action. Look at the bottom card of your deck. You may put it on top.', [
	rules.plusCards(1),
	rules.plusActions(1),
	function(p, c) {
		if(p.deck_.length <= 0) {
			p.shuffleDiscards();
		}

		if(p.deck_.length <= 0) {
			p.logMe('has no deck to look at.');
			c();
			return;
		}

		var yn = rules.yesNo('The bottom card of your deck was ' + p.deck_[0].name + '. Place it on top of your deck?',
			function(p, c) {
				p.deck_.push(p.deck_.shift());
				p.logMe('puts the bottom card of his deck on top.');
                c();
			}, function(p, c) {
				p.logMe('leaves the bottom card of his deck on the bottom.');
                c();
			}
		);

		yn(p,c);
	}
]);


dom.cards['Ambassador'] = new dom.card('Ambassador', { 'Action': 1, 'Attack': 1 }, 3, 'Reveal a card from your hand. Return up to 2 copies of it from your hand to the Supply. Then each other player gains a copy of it.', [
	function(p, c) {
		dom.utils.handDecision(p, 'Choose a card to reveal.', null, dom.utils.const(true),
			function(index) {
				var card = p.hand_[index];
				p.logMe('reveals ' + card.name + '.');
				var count = p.hand_.filter(function(c) { return c.name == card.name; }).length;
				
				var options = [
					new dom.Option('0', 'None'),
					new dom.Option('1', 'One') ];
				if(count > 1) {
					options.push(new dom.Option('2', 'Two'));
				}

				var kingdomIndex = p.game_.indexInKingdom(card.name);
				var inKingdom = p.game_.kingdom[kingdomIndex];

				var dec = new dom.Decision(p, options, 'Choose how many copies of ' + card.name + ' to return to the Supply pile.', []);
				p.game_.decision(dec, function(key) {
					var removed = 0;
					for(var i = 0; i < p.hand_.length && removed < key; i++) {
						if(p.hand_[i].name == card.name) {
							p.removeFromHand(i);
							inKingdom.count++;
							removed++;
						}
					}

					var strs = {
						0: 'no copies',
						1: 'one copy',
						2: 'two copies'
					};
					p.logMe('removes ' + strs[key] + ' of ' + card.name + ' from their hand.');

					var f = rules.everyOtherPlayer(false, true, function(active, p, c) {
						p.buyCard(kingdomIndex, true);
						c();
					});
					f(p, c);
				});
			}, c);
	}
]);


dom.cards['Fishing Village'] = new dom.card('Fishing Village', { 'Action': 1, 'Duration': 1 }, 3, '+2 Actions, +1 Coin. At the start of your next turn: +1 Action, +1 Coin.', [
	rules.plusActions(2),
	rules.plusCoin(1),
	function(p, c) {
		p.durationRules.push({ name: 'Fishing Village', rules: [ rules.plusActions(1), rules.plusCoin(1) ] });
		c();
	}
]);


dom.cards['Lookout'] = new dom.card('Lookout', { 'Action': 1 }, 3, '+1 Action. Look at the top 3 cards of your deck. Trash one of them. Discard one of them. Put the other one on top of your deck.', [
	rules.plusActions(1),
	function(p,c) {
		// abuse draw() again
		var drawn = p.draw(3);
		var cards = [];
		for(var i = 0; i < drawn; i++) {
			cards.push(p.hand_.pop());
		}

		var options = dom.utils.cardsToOptions(cards);
		var dec = new dom.Decision(p, options, 'You have played Lookout. You must choose one card to trash, one to discard, and one to put back on your deck. Choose first the card to trash.', []);
		p.game_.decision(dec, dom.utils.decisionHelper(c, function(index) {
			p.logMe('trashes ' + cards[index].name + '.');
			var cards2 = [];
			for(var i = 0; i < cards.length; i++) {
				if(i != index) {
					cards2.push(cards[i]);
				}
			}

			if(cards2.length == 0) {
				p.logMe('has no cards remaining for Lookout.');
				c();
				return;
			}

			var options = dom.utils.cardsToOptions(cards2);
			var dec = new dom.Decision(p, options, 'You must now choose a card to discard.', []);
			p.game_.decision(dec, dom.utils.decisionHelper(c, function(index) {
				p.logMe('discards ' + cards2[index].name + '.');
				p.discards_.push(cards2[index]);

				if(cards2.length > 1) {
					var deckIndex = index == 1 ? 0 : 1;
					p.deck_.push(cards2[deckIndex]);
				}

				c();
			}, c));
		}, c));
	}
]);


dom.cards['Smugglers'] = new dom.card('Smugglers', { 'Action': 1 }, 3, 'Gain a copy of a card costing up to 6 Coins that the player to your right gained on his last turn.', [
	function(p, c) {
		var index;
		for(var i = 0; i < p.game_.players.length; i++) {
			if(p.id_ == p.game_.players[i].id_) {
				index = i;
				break;
			}
		}

		index--;
		if(index < 0) {
			index = p.game_.players.length - 1;
		}

		var other = p.game_.players[index];

		var gained = other.temp['gainedLastTurn'];

		gained = gained.unique(function(x,y) { return x.card.name == y.card.name; }).filter(function(c) { return p.game_.cardCost(c.card) <= 6; });

		if(gained.length == 0) {
			other.logMe('gained no valid cards last turn.');
			c();
			return;
		}

		var map = {};
		for(var i = 0; i < gained.length; i++) {
			map[gained[i].card.name] = p.game_.indexInKingdom(gained[i].card.name);
		}

		var options = gained.map(function(c) { return new dom.Option(c.card.name, c.card.name); });
		var dec = new dom.Decision(p, options, 'Choose a card to gain from those that ' + other.name + ' gained last turn.', []);
		p.game_.decision(dec, function(key) {
			p.buyCard(map[key], true);
			c();
		});
	}
]);
		

dom.cards['Warehouse'] = new dom.card('Warehouse', { 'Action': 1 }, 3, '+3 Cards, +1 Action. Discard 3 cards.', [
	rules.plusCards(3),
	rules.plusActions(1),
	function(p, c) {
		var discard = function(count) {
			if(count <= 0) {
				c();
				return;
			}

			dom.utils.handDecision(p, 'Choose a card to discard.', null, dom.utils.const(true), function(index) {
				p.logMe('discards ' + p.hand_[index].name + '.');
				p.removeFromHand(index);

				discard(count-1);
			}, c);
		};

		discard(3);
	}
]);


dom.cards['Caravan'] = new dom.card('Caravan', { 'Action': 1, 'Duration': 1 }, 4, '+1 Card, +1 Action. At the start of your next turn, +1 Card.', [
	rules.plusCards(1),
	rules.plusActions(1),
	function(p,c) {
		p.durationRules.push({ name: 'Caravan', rules: [ rules.plusCards(1) ] });
		c();
	}
]);


dom.cards['Cutpurse'] = new dom.card('Cutpurse', { 'Action': 1, 'Attack': 1 }, 4, '+2 Coin. Each other player discards a Copper card (or reveals a hand with no Copper).', [
	rules.plusCoin(2),
	rules.everyOtherPlayer(true, true, function(active, p, c) {
		var coppers = p.hand_.filter(function(c) { return c.name == 'Copper'; });
		if(coppers.length > 0) {
			p.logMe('discards a Copper.');
			for(var i = 0; i < p.hand_.length; i++) {
				if(p.hand_[i].name == 'Copper') {
					p.removeFromHand(i);
					break;
				}
			}
		} else {
			p.logMe('reveals a hand with no Copper: ' + p.hand_.map(function(c) { return c.name; }).join(', '));
		}
		c();
	})
]);


dom.cards['Island'] = new dom.card('Island', { 'Action': 1, 'Victory': 1 }, 4, 'Set aside this and another card from your hand. Return them to your deck at the end of the game. 2 VP.', [
	function(p, c) {
		dom.utils.handDecision(p, 'Choose a card to set aside until the end of the game.', null, dom.utils.const(true),
			function(index) {
				var card = p.hand_[index];
				p.removeFromHand(index);
				if(!p.temp.islandSetAside) p.temp.islandSetAside = [];
				p.temp.islandSetAside.push(card);

				// and the Island too, if it wasn't Throme Room'd or whatever.
				if(p.inPlay_.length > 0 && p.inPlay_[p.inPlay_.length-1].name == 'Island') {
					p.temp.islandSetAside.push(p.inPlay_.pop());
				}

				p.logMe('sets aside Island and another card.');
				c();
			}, c);
	}
]);


dom.cards['Navigator'] = new dom.card('Navigator', { 'Action': 1 }, 4, '+2 Coin. Look at the top 5 cards of your deck. Either discard all of them, or put them back on top of your deck in any order.', [
	rules.plusCoin(2),
	function(p, c) {
		var drawn = p.draw(5);
		var cards = [];
		for(var i = 0; i < drawn; i++) {
			cards.push(p.hand_.pop());
		}

		var opts = [ new dom.Option('discard', 'Discard them all'), new dom.Option('keep', 'Put them back in any order') ];
		var dec = new dom.Decision(p, opts, 'Choose whether to discard or put back the cards below.', [cards.map(function(c) { return c.name; }).join(', ')]);
		var repeat = function() {
			p.game_.decision(dec, function(key) {
				if(key == 'discard') {
					for(var i = 0; i < cards.length; i++) {
						p.discards_.push(cards[i]);
					}
					c();
				} else if(key == 'keep') {
					var putBack = function(time, cards) {
						if(cards.length == 0) {
							c();
							return;
						}

						var opts = dom.utils.cardsToOptions(cards);
						var dec = new dom.Decision(p, opts, 'Choose the card to draw ' + (time == 1 ? 'first' : 'next') + '.', []);
						p.game_.decision(dec, dom.utils.decisionHelper(dom.utils.nullFunction, function(index) {
                            p.deck_.push(cards[index]);
                            var newcards = [];
                            for(var i = 0; i < cards.length; i++) {
                                if(i != index) {
                                    newcards.push(cards[i]);
                                }
                            }
                            putBack(time+1, newcards);
                        }, function() { c(); }));
                    };

                    putBack(1, cards);
                }
            });
        };

        repeat();
    }]);


dom.cards['Pirate Ship'] = new dom.card('Pirate Ship', { 'Action': 1, 'Attack': 1 }, 4, 'Choose one: Each other player reveals the top 2 cards of his deck, trashes a revealed Treasure that you choose, discards the rest, and if anyone trashed a Treasure you take a Coin token; or, +1 Coin per Coin token you\'ve taken with Pirate Ships this game.', [
	function(p, c) {
        if(!p.temp['Pirate Ship coins']) {
            p.temp['Pirate Ship coins'] = 0;
        }
        p.temp['Pirate Ship attack'] = 0;

        var opts = [new dom.Option('attack', 'Attack the other players'), new dom.Option('coin', 'Gain ' + p.temp['Pirate Ship coins'] + ' Coin')];
        var dec = new dom.Decision(p, opts, 'Choose what to do with your Pirate Ship.', []);
        p.game_.decision(dec, function(key) {
            if(key == 'coin') {
                rules.plusCoin(p.temp['Pirate Ship coins'])(p,c);
            } else {
                var rule = rules.everyOtherPlayer(true, true, function(p, o, c) {
                    var drawn = o.draw(2);
                    if(!drawn) {
                        o.logMe('has no cards to draw.');
                        c();
                        return;
                    }

                    var cards = [];
                    for(var i = 0; i < drawn; i++) {
                        cards.push(o.hand_.pop());
                    }

                    var treasure = cards.filter(function(x) { return x.types['Treasure']; });

                    var log = 'reveals ' + cards[0].name + (cards.length > 1 ? ' and ' + cards[1].name : '') + ', ';
                    
                    if(treasure.length == 0) {
                        o.logMe(log + 'discarding ' + (cards.length > 1 ? 'both' : 'it') + '.');
                        cards.map(o.discards_.push);
                        c();
                    } else if(treasure.length == 1) {
                        if(cards.length == 1) {
                            o.logMe(log + 'trashing it.');
                            p.temp['Pirate Ship attack']++;
                            c();
                        } else {
                            for(var i = 0; i < cards.length; i++) {
                                if(cards[i] != treasure[0]) {
                                    o.discards_.push(cards[i]);
                                    log += 'trashing the ' + treasure[0].name + ' and discarding the ' + cards[i].name + '.';
                                    p.temp['Pirate Ship attack']++;
                                }
                            }
                            o.logMe(log);
                            c();
                        }
                    } else {
                        var opts = dom.utils.cardsToOptions(cards);
                        var dec = new dom.Decision(p, opts, 'Choose which of ' + o.name + '\'s Treasures to trash', []);
                        p.game_.decision(dec, dom.utils.decisionHelper(o, function(index) {
                            p.logMe('trashes ' + o.name + '\'s ' + cards[index].name + '.');
                            o.discards_.push(cards[1-index]);
                            p.temp['Pirate Ship attack']++;
                            c();
                        }, c));
                    }
                });
                rule(p, function() {
                    if(p.temp['Pirate Ship attack'] > 0) {
                        p.temp['Pirate Ship coins']++;
                        p.logMe('gains a Pirate Ship token.');
                    }
                    c();
                });
            }
        });
    }
]);


dom.cards['Salvager'] = new dom.card('Salvager', { 'Action': 1 }, 4, '+1 Buy, Trash a card from your hand. +Coins equal to its cost.', [
    rules.plusBuys(1),
    function(p, c) {
        var opts = dom.utils.cardsToOptions(p.hand_);
        var dec = new dom.Decision(p, opts, 'Choose a card to trash. You will gain +Coins equal to its cost.', []);
        p.game_.decision(dec, dom.utils.decisionHelper(dom.utils.nullFunction, function(index) {
            var trashed = p.hand_[index];
            var cards = [];
            for(var i = 0; i < p.hand_.length; i++) {
                if(i != index) {
                    cards.push(p.hand_[i]);
                }
            }
            p.hand_ = cards;
            var coins = p.game_.cardCost(trashed);
            p.logMe('trashes ' + trashed.name + ', gaining +' + coins + ' Coins.');
            p.coin += coins;
            c();
        }, c));
    }
]);


dom.cards['Sea Hag'] = new dom.card('Sea Hag', { 'Action': 1, 'Attack': 1 }, 4, 'Each other player discards the top card of his deck, then gains a Curse card, putting it on top of his deck.', [
    rules.everyOtherPlayer(false, true, function(p, o, c) {
        var iCurse = p.game_.indexInKingdom('Curse');

        var log;
        var drawn = o.draw();
        if(!drawn) {
            log = 'has no top card to discard, ';
        } else {
            var discarded = o.hand_.pop();
            o.discards_.push(discarded);
            log = 'discards the top card of his deck (' + discarded.name + '), ';
        }

        if(p.game_.kingdom[iCurse].count > 0) {
            o.deck_.push(dom.cards['Curse']);
            o.game_.kingdom[iCurse].count--;
            o.logMe(log + 'putting a Curse on top of his deck.');
        } else {
            o.logMe(log + 'but there are no more Curses.');
        }
        c();
    })
]);


dom.cards['Treasure Map'] = new dom.card('Treasure Map', { 'Action': 1 }, 4, 'Trash this and another copy of Treasure Map from your hand. If you do trash two Treasure Maps, gain 4 Gold cards, putting them on top of your deck.', [
    function(p, c) {
        var another = false;
        var newhand = [];
        for(var i = 0; i < p.hand_.length; i++) {
            if(p.hand_[i].name == 'Treasure Map') {
                another = true;
            } else {
                newhand.push(p.hand_[i]);
            }
        }
        p.hand_ = newhand;

        var newInPlay = [];
        for(var i = 0; i < p.inPlay_.length; i++){
            if(p.inPlay_[i].name != 'Treasure Map') {
                newInPlay.push(p.inPlay_[i]);
            }
        }
        p.inPlay_ = newInPlay;

        if(another) {
            p.logMe('trashes two Treasure Maps, putting 4 Gold on top of his deck.');
            for(var i = 0; i < 4; i++) {
                p.deck_.push(dom.cards['Gold']);
            }
        }

        c();
    }
]);


dom.cards['Bazaar'] = new dom.card('Bazaar', { 'Action': 1 }, 5, '+1 Card, +2 Actions, +1 Coin.', [
    rules.plusCards(1),
    rules.plusActions(2),
    rules.plusCoin(1)
]);


dom.cards['Explorer'] = new dom.card('Explorer', { 'Action': 1 }, 5, 'You may reveal a Province card from your hand. If you do, gain a Gold card, putting it into your hand. Otherwise, gain a Silver card, putting it into your hand.', [
    function(p, c) {
        var provinces = p.hand_.filter(function(x) { return x.name == 'Province'; });
        var noProvince = function(p, c) {
            p.logMe('gains a Silver, putting it in his hand.');
            p.hand_.push(dom.cards['Silver']);
            c();
        };

        if(provinces.length > 0) {
            var yn = rules.yesNo('Do you want to reveal a Province?', function(p, c) {
                p.logMe('reveals a Province card and gains a Gold, putting it in his hand.');
                p.hand_.push(dom.cards['Gold']);
                c();
            }, noProvince);
            yn(p, c);
        } else {
            noProvince(p, c);
        }
    }
]);


dom.cards['Ghost Ship'] = new dom.card('Ghost Ship', { 'Action': 1, 'Attack': 1 }, 5, '+2 Card. Each other player with 4 or more cards in hand puts cards from his hand on top of his deck until he has 3 cards in his hand.', [
    rules.plusCards(2),
    rules.everyOtherPlayer(true, true, function(p, o, c) {
        if(o.hand_.length < 4) {
            o.logMe('has fewer than 4 cards in his hand.');
            c();
            return;
        }

        var repeat = function() {
            if(o.hand_.length <= 3) {
                o.logMe('discards down to 3 cards in hand, putting the cards on top of his deck.');
                c();
                return;
            }

            var opts = dom.utils.cardsToOptions(o.hand_);
            var dec = new dom.Decision(o, opts, 'Choose a card to discard onto the top of your deck. You must discard down to 3 cards in hand.', []);
            o.game_.decision(dec, dom.utils.decisionHelper(dom.utils.nullFunction, function(index) {
                var newcards = [];
                for(var i = 0; i < o.hand_.length; i++) {
                    if(i == index) {
                        o.deck_.push(o.hand_[i]);
                    } else {
                        newcards.push(o.hand_[i]);
                    }
                }
                o.hand_ = newcards;

                repeat();
            }, dom.utils.nullFunction));
        };

        repeat();
    })
]);


dom.cards['Merchant Ship'] = new dom.card('Merchant Ship', { 'Action': 1, 'Duration': 1 }, 5, 'Now and at the start of your next turn: +2 Coins.', [
    rules.plusCoin(2),
    function(p, c) {
        p.durationRules.push({ name: 'Merchant Ship', rules: [ function(p) {
            p.coin += 2;
            p.logMe('gains +2 Coin.');
        }] });

        c();
    }
]);


dom.cards['Outpost'] = new dom.card('Outpost', { 'Action': 1, 'Duration': 1 }, 5, 'You only draw 3 cards (instead of 5) in this turn\'s Clean-up phase. Take an extra turn after this one. This can\'t cause you to take more than two consecutive turns.', [
    function(p, c) {
        if(p.temp['Outpost turns'] >= 2) {
            p.logMe('will not get an extra turn, as he has played two consecutive turns already.');
        } else {
            p.temp['Outpost active'] = true;
            p.temp['Outpost turns'] = 1;
        }
        c();
    }
]);


dom.cards['Tactician'] = new dom.card('Tactician', { 'Action': 1, 'Duration': 1 }, 5, 'Discard your whole hand. If you discarded any cards this way, then at the start of your next turn, +5 Cards, +1 Buy, and +1 Action.', [
    function(p, c) {
        if(p.hand_.length == 0) {
            p.logMe('has no hand to discard, so Tactician has no effect.');
            c();
            return;
        }

        while(p.hand_.length) {
            p.discards_.push(p.hand_.pop());
        }

        p.durationRules.push({ name: 'Tactician', rules: [ function(p) {
            p.logMe('gains +5 Cards, +1 Buy, and +1 Action.');
            p.draw(5);
            p.actions++;
            p.buys++;
        }] });

        c();
    }
]);


dom.cards['Treasury'] = new dom.card('Treasury', { 'Action': 1 }, 5, '+1 Card, +1 Action, +1 Coin. When you discard this from play, if you didn\'t buy a Victory card this turn, you may put this on top of your deck.', [
    rules.plusCards(1),
    rules.plusActions(1),
    rules.plusCoin(1)
]);


dom.cards['Wharf'] = new dom.card('Wharf', { 'Action': 1, 'Duration': 1 }, 5, 'Now and at the start of your next turn: +2 Cards, +1 Buy.', [
    rules.plusCards(2),
    rules.plusBuys(1),
    function(p, c) {
        p.durationRules.push({ name: 'Wharf', rules: [ function(p) {
            p.logMe('gains +2 Cards and +1 Buy');
            p.draw(2);
            p.buys++;
        }] });
        c();
    }
]);


dom.cards['Courtyard'] = new dom.card('Courtyard', { 'Action': 1 }, 2, '+3 Cards. Put a card from your hand on top of your deck.', [
    rules.plusCards(3),
    function(p, c) {
        var opts = dom.utils.cardsToOptions(p.hand_);
        var dec = new dom.Decision(p, opts, 'Choose a card from your hand to put back on top of your deck.', []);
        p.game_.decision(dec, dom.utils.decisionHelper(dom.utils.nullFunction, function(index) {
            p.deck_.push(p.hand_[index]);

            var newhand = [];
            for(var i = 0; i < p.hand_.length; i++) {
                if(i != index) {
                    newhand.push(p.hand_[i]);
                }
            }
            p.hand_ = newhand;
            p.logMe('puts a card on top of his deck.');
            c();
        }, dom.utils.nullFunction));
    }
]);


dom.cards['Pawn'] = new dom.card('Pawn', { 'Action': 1 }, 2, 'Choose two: +1 Card, +1 Action, +1 Buy, +1 Coin. (The choices must be different.).', [
    function(p, c) {
        var opts = [new dom.Option('card', '+1 Card'), new dom.Option('action', '+1 Action'), new dom.Option('buy', '+1 Buy'), new dom.Option('coin', '+1 Coin')];
        var dec1 = new dom.Decision(p, opts, 'Choose the first effect of Pawn.', []);


        var handler = function(times) {
            return function(key) {
                if(key == 'card') {
                    if(p.draw()) {
                        p.logMe('draws 1 card.');
                    } else {
                        p.logMe('has no cards left to draw.');
                    }
                } else if(key == 'action') {
                    p.actions++;
                    p.logMe('gains +1 Action.');
                } else if(key == 'buy') {
                    p.buys++;
                    p.logMe('gains +1 Buy.');
                } else if(key == 'coin') {
                    p.coin++;
                    p.logMe('gains +1 Coin.');
                }

                if(times >= 2) {
                    c();
                    return;
                }

                var newopts = [];
                for(var i = 0; i < 4; i++) {
                    if(opts[i].key != key) {
                        newopts.push(opts[i]);
                    }
                }

                var dec2 = new dom.Decision(p, newopts, 'Choose the second effect of Pawn.', []);
                p.game_.decision(dec2, handler(2));
            };
        };

        p.game_.decision(dec1, handler(1));
    }
]);


dom.cards['Secret Chamber'] = new dom.card('Secret Chamber', { 'Action': 1, 'Reaction': 1 }, 2, 'Discard any number of cards. +1 Coin per card discarded. -- When another player plays an Attack card, you may reveal this from your hand. If you do, +2 Cards, then put 2 cards from your hand on top of your deck.', [
    rules.discardMany(function(p, c, discarded) {
        p.logMe('discards ' + discarded.length + ' cards and gains +' + discarded.length +' Coin.');
        p.coin += discarded.length;
        c();
    })
]);
dom.cards['Secret Chamber'].reactionRule = rules.yesNo('Do you want to reveal your Secret Chamber? (+2 Cards, then put 2 cards from your hand on top of your deck.)',
    function(p, c) { //yes
        p.logMe('reveals a Secret Chamber, gaining +2 Cards and putting 2 cards on top of his deck.');
        p.draw(2);

        var count = 0;
        var messages = ['Choose the first card to put back on top of your deck (next card will go on top of it).',
                        'Choose the second card to put back on top of your deck (goes on top).'];

        var repeat = function() {
            dom.utils.handDecision(p, messages[count], null, dom.utils.const(true),
                function(index) {
                    var card = p.hand_[index];
                    p.removeFromHand(index);
                    p.deck_.push(card);

                    count++;
                    if(count > 1) {
                        c();
                        return;
                    }
                    repeat();
                }, dom.utils.nullFunction);
        };
        repeat();
    }, function(p, c) { //no
        c();
    });


dom.cards['Great Hall'] = new dom.card('Great Hall', { 'Action': 1, 'Victory': 1 }, 3, '+1 Card, +1 Action. 1 VP.', [
    rules.plusCards(1),
    rules.plusActions(1)
]);


dom.cards['Masquerade'] = new dom.card('Masquerade', { 'Action': 1 }, 3, '+2 Cards. Each player passes a card in their hand to the player on their left. You may trash a card from your hand.', [
    rules.everyPlayer(true, true, false, function(p, o, c) {
        dom.utils.handDecision(o, 'Choose a card to pass to the player to your left', null, dom.utils.const(true), function(index) {
            var card = o.hand_[index];
            o.removeFromHand(index);

            var live = false;
            var handled = false;
            var targetPlayer;
            for(var i = 0; i < p.game_.players.length; i++) {
                if(live) {
                    targetPlayer = p.game_.players[i];
                    targetPlayer.temp['Masquerade card'] = card;
                    handled = true;
                    break;
                }
                if(p.game_.players[i].id_ == o.id_) {
                    live = true;
                }
            }

            if(live && !handled) {
                targetPlayer = p.game_.players[0];
                targetPlayer.temp['Masquerade card'] = card;
            }
            o.logMe('passes a card to ' + targetPlayer.name);
            c();
        }, c);
    }),
    function(p, c) {
        for(var i = 0; i < p.game_.players.length; i++) {
            p.game_.players[i].hand_.push(p.game_.players[i].temp['Masquerade card']);
        }

        dom.utils.handDecision(p, 'Choose a card to trash, or to trash nothing.', 'Trash nothing', dom.utils.const(true), function(index) {
            p.logMe('trashes ' + p.hand_[index].name + '.');
            p.removeFromHand(index);
            c();
        }, c);
    }
]);


dom.cards['Shanty Town'] = new dom.card('Shanty Town', { 'Action': 1 }, 3, '+2 Actions. Reveal your hand. If you have no Action cards in hand, +2 Cards.', [
    rules.plusActions(2),
    function(p, c) {
        p.logMe('reveals his hand: ' + dom.utils.showCards(p.hand_));

        var actions = p.hand_.filter(function(x) { return x.types['Action']; });
        if(actions.length) {
            p.logMe('has Actions in hand.');
        } else {
            var drawn = p.draw(2);
            p.logMe('has no Actions, and draws ' + drawn + ' cards.');
        }

        c();
    }
]);


dom.cards['Steward'] = new dom.card('Steward', { 'Action': 1 }, 3, 'Choose one: +2 Cards; or +2 Coins; or trash 2 cards from your hand.', [
    function(p, c) {
        var opts = [new dom.Option('cards', '+2 Cards'),
                    new dom.Option('coins', '+2 Coin'),
                    new dom.Option('trash', 'Trash 2 cards from your hand.')];
        var dec = new dom.Decision(p, opts, 'Choose one of the options for Steward.', []);
        p.game_.decision(dec, function(key) {
            if(key == 'cards') {
                rules.plusCards(2)(p, c);
            } else if(key == 'coins') {
                rules.plusCoin(2)(p, c);
            } else {
                var repeat = function(count) {
                    if(count > 1) {
                        c();
                        return;
                    }

                    dom.utils.handDecision(p, 'Choose the ' + (count ? 'second' : 'first') + ' card to trash.', null, dom.utils.const(true), function(index) {
                        p.logMe('trashes ' + p.hand_[index].name);
                        p.removeFromHand(index);
                        repeat(count+1);
                    }, dom.utils.nullFunction);
                };
                repeat(0);
            }
        });
    }
]);


dom.cards['Swindler'] = new dom.card('Swindler', { 'Action': 1, 'Attack': 1 }, 3, '+2 Coin. Each other player trashes the top card of his deck and gains a card with the same cost that you choose.', [
    rules.plusCoin(2),
    rules.everyOtherPlayer(false, true, function(p, o, c) {
        var drawn = o.draw();
        if(drawn == 0) {
            o.logMe('has no cards to draw.');
            c();
            return;
        }

        var topCard = o.hand_.pop();
        var log = 'trashes his top card, ' + topCard.name;
        var cost = p.game_.cardCost(topCard);

        var replacements = p.game_.kingdom
                            .filter(function(x) { return x.count > 0; })
                            .map(function(x) { return x.card; })
                            .filter(function(x) { return p.game_.cardCost(x) == cost; });

        if(replacements.length == 0) {
            o.logMe(log + ', but there are no replacements.');
            c();
        } else if(replacements.length == 1) {
            var index = p.game_.indexInKingdom(replacements[0].name);
            o.logMe(log + '.');
            o.buyCard(index, true);
            c();
        } else {
            o.logMe(log + '.');
            var opts = dom.utils.cardsToOptions(replacements);
            var dec = new dom.Decision(p, opts, 'Choose a replacement for ' + o.name + '\'s Swindled ' + topCard.name + '.', []);
            p.game_.decision(dec, dom.utils.decisionHelper(dom.utils.nullFunction, function(index) {
                o.buyCard(p.game_.indexInKingdom(replacements[index].name));
                c();
            }, c));
        }
    })
]);


dom.cards['Wishing Well'] = new dom.card('Wishing Well', { 'Action': 1 }, 3, '+1 Card, +1 Action. Name a card, then reveal the top card of your deck. If it is the named card, put it in your hand.', [
    rules.plusCards(1),
    rules.plusActions(1),
    function(p, c) {
        var kingdomCards = p.game_.kingdom.map(function(x){ return x.card; });
        var opts = dom.utils.cardsToOptions(kingdomCards);
        var dec = new dom.Decision(p, opts, 'Name the card to wish for.', []);
        p.game_.decision(dec, dom.utils.decisionHelper(dom.utils.nullFunction, function(index) {
            p.logMe('wishes for ' + kingdomCards[index].name + '.');

            var drawn = p.draw();
            if(!drawn) {
                p.logMe('has no cards to draw.');
                c();
                return;
            }

            var drawnCard = p.hand_[p.hand_.length-1];
            if(drawnCard.name == kingdomCards[index].name) {
                p.logMe('reveals ' + drawnCard.name + ', putting it into his hand.');
            } else {
                p.logMe('reveals ' + drawnCard.name + ', discarding it.');
                p.discards_.push(p.hand_.pop());
            }
            c();
        }, c));
    }
]);


dom.cards['Baron'] = new dom.card('Baron', { 'Action': 1 }, 4, '+1 Buy. You may discard an Estate card. If you do, +4 Coins. Otherwise, gain an Estate card.', [
    rules.plusBuys(1),
    function(p, c) {
        var estateIndex = -1;
        for(var i = 0; i < p.hand_.length; i++) {
            if(p.hand_[i].name == 'Estate') {
                estateIndex = i;
                break;
            }
        }

        if(estateIndex < 0) {
            p.buyCard(p.game_.indexInKingdom('Estate'), true);
            c();
        } else {
            var yn = rules.yesNo('Discard an Estate for Baron?', function(p, c) {
                var card = p.hand_[estateIndex];
                p.removeFromHand(estateIndex);
                p.discards_.push(card);
                p.logMe('discards an Estate.');
                rules.plusCoin(4)(p,c);
            }, function(p, c) {
                p.buyCard(p.game_.indexInKingdom('Estate'), true);
                c();
            });
            yn(p, c);
        }
    }
]);


dom.cards['Bridge'] = new dom.card('Bridge', { 'Action': 1 }, 4, '+1 Buy, +1 Coin. All cards (including cards in players\' hands) cost 1 Coin less this turn, but not less than 0 Coin.', [
    rules.plusBuys(1),
    rules.plusCoin(1),
    function(p, c) {
        p.logMe('reduces all prices by 1 this turn.');
        p.game_.bridges++;
        c();
    }
]);


dom.cards['Conspirator'] = new dom.card('Conspirator', { 'Action': 1 }, 4, '+2 Coin. If you\'ve played 3 or more Actions this turn (counting this): +1 Card, +1 Action.', [
    rules.plusCoin(2),
    function(p, c) {
        var actionsPlayed = p.inPlay_.filter(function(x) { return x.types['Action']; });
        if(actionsPlayed.length >= 3) {
            rules.plusCards(1)(p,dom.utils.nullFunction);
            rules.plusActions(1)(p,c);
        } else {
            c();
        }
    }
]);


dom.cards['Coppersmith'] = new dom.card('Coppersmith', { 'Action': 1 }, 4, 'Copper produces an extra 1 Coin this turn.', [
    function(p, c) {
        p.logMe('Copper produces an extra 1 Coin this turn.');
        p.game_.coppersmiths++;
        c();
    }
]);


dom.cards['Ironworks'] = new dom.card('Ironworks', { 'Action': 1 }, 4, 'Gain a card costing up to 4 Coin. If it is an: Action card, +1 Action; Treasure card, +1 Coin; Victory card, +1 Card.', [
    function(p, c) {
        dom.utils.gainCardDecision(p, 'Gain a card costing up to 4 Coin.', null, [], function(c) { return p.game_.cardCost(c) <= 4; }, function(repeat) {
            return dom.utils.decisionHelper(dom.utils.nullFunction, function(index) {
                var card = p.game_.kingdom[index].card;

                if(card.types['Action']) {
                    rules.plusActions(1)(p, dom.utils.nullFunction);
                }
                if(card.types['Treasure']) {
                    rules.plusCoin(1)(p, dom.utils.nullFunction);
                }
                if(card.types['Victory']) {
                    rules.plusCards(1)(p, dom.utils.nullFunction);
                }

                c();
            }, repeat);
        });
    }
]);


dom.cards['Mining Village'] = new dom.card('Mining Village', { 'Action': 1 }, 4, '+1 Card, +2 Actions. You may trash this card immediately. If you do, +2 Coin.', [
    rules.plusCards(1),
    rules.plusActions(2),
    rules.yesNo('Trash the Mining Village for +2 Coin?', function(p, c) {
        var card = p.inPlay_.pop();
        if(card.name == 'Mining Village') {
            p.logMe('trashes Mining Village for +2 Coin.');
            rules.plusCoin(2)(p, c);
        } else {
            p.logMe('has no Mining Village to trash.');
            p.inPlay_.push(card);
            c();
        }
    }, function(p, c) {
        p.logMe('doesn\'t trash Mining Village.');
        c();
    })
]);


dom.cards['Scout'] = new dom.card('Scout', { 'Action': 1 }, 4, '+1 Action. Reveal the top 4 cards of your deck. Put the revealed Victory cards into your hand. Put the other cards on top of your deck in any order.', [
    rules.plusActions(1),
    function(p, c) {
        var drawn = p.draw(4);

        var cards = [];
        for(var i = 0; i < drawn; i++) {
            cards.push(p.hand_.pop());
        }

        p.logMe('reveals the top ' + drawn + ' cards of his deck: ' + dom.utils.showCards(cards) + '.');

        var victoryCards = cards.filter(function(x){ return  x.types['Victory']; });
        var otherCards   = cards.filter(function(x){ return !x.types['Victory']; });

        p.logMe('puts the Victory cards (' + dom.utils.showCards(victoryCards) + ') into his hand.');

        var repeat = function(cards) {
            if(!cards.length) {
                p.logMe('puts the other revealed cards on top of his deck.');
                c();
                return;
            } else if(cards.length == 1) {
                p.deck_.push(cards[0]);
                repeat([]);
                return;
            }

            var opts = dom.utils.cardsToOptions(cards);
            var dec = new dom.Decision(p, opts, 'Choose the next card to put on your deck. Later cards will go on top of it.', []);
            p.game_.decision(dec, dom.utils.decisionHelper(dom.utils.nullFunction, function(index) {
                var newcards = [];
                for(var i = 0; i < cards.length; i++){
                    if(i != index) {
                        newcards.push(cards[i]);
                    } else {
                        p.deck_.push(cards[i]);
                    }
                }

                repeat(newcards);
            }, function() { repeat(cards); }));
        }
        repeat(otherCards);
    }
]);


dom.cards['Duke'] = new dom.card('Duke', { 'Victory': 1 }, 5, 'Worth 1 VP per Duchy you have.', []);


dom.cards['Minion'] = new dom.card('Minion', { 'Action': 1, 'Attack': 1 }, 5, '+1 Action. Choose one: +2 Coin; or discard your hand, +4 Cards, and each other player with at least 5 cards in hand discards his hand and draws 4 cards.', [
    rules.plusActions(1),
    function(p, c) {
        var opts = [new dom.Option('coin', '+2 Coin'), new dom.Option('hand', 'Discard your hand, +4 Cards, everyone discards and draws 4.')];
        var dec = new dom.Decision(p, opts, 'Choose which action for your Minion.', []);
        p.game_.decision(dec, function(key) {
            if(key == 'coin') {
                rules.plusCoin(2)(p, c);
            } else {
                dom.utils.append(p.discards_, p.hand_);
                p.hand_ = [];
                var drawn = p.draw(4);
                p.logMe('discards his whole hand and draws ' + drawn + ' cards.');

                var rule = rules.everyOtherPlayer(true, true, function(p, o, c) {
                    if(o.hand_.length >= 5) {
                        dom.utils.append(o.discards_, o.hand_);
                        o.hand_ = [];
                        var drawn = o.draw(4);
                        o.logMe('discards his whole hand and draws ' + drawn + ' cards.');
                        c();
                    } else {
                        o.logMe('has fewer than 5 cards in hand.');
                        c();
                    }
                });
                rule(p, c);
            }
        });
    }
]);


dom.cards['Saboteur'] = new dom.card('Saboteur', { 'Action': 1, 'Attack': 1 }, 5, 'Each other player reveals cards from the top of his deck until revealing one costing 3 Coin or more. He trashes that card and may gain a card costing at most 2 Coin less than it. He discards the other revealed cards.', [
    rules.everyOtherPlayer(false, true, function(p, o, c) {
        var repeat = function(revealed) {
            var drawn = o.draw();
            if(!drawn) {
                o.logMe('has drawn his whole deck and has no cards costing 3 Coin or more.');
                dom.utils.append(o.discards_, revealed);
                c();
                return;
            }

            var card = o.hand_.pop();
            o.logMe('reveals ' + card.name + ' (' + p.game_.cardCost(card) + ').');
            if(p.game_.cardCost(card) >= 3) {
                o.logMe('trashes ' + card.name + '.');
                dom.utils.append(o.discards_, revealed);
                dom.utils.gainCardDecision(o, 'Choose a card to replace your ' + card.name + '.', 'Gain nothing.', [], function(c) { return p.game_.cardCost(c) <= p.game_.cardCost(card) - 2; }, function(repeat) {
                    return dom.utils.decisionHelper(c, function(index) {
                        o.buyCard(index, true);
                        c();
                    }, repeat);
                });
            } else {
                revealed.push(card);
                repeat(revealed);
            }
        };

        repeat([]);
    })
]);


dom.cards['Torturer'] = new dom.card('Torturer', { 'Action': 1, 'Attack': 1 }, 5, '+3 Cards. Each other player chooses one: he discards 2 cards; or he gains a Curse card, putting it in his hand.', [
    rules.plusCards(3),
    rules.everyOtherPlayer(false, true, function(p, o, c) {
        var opts = [new dom.Option('discard', 'Discard 2 cards.'), new dom.Option('curse', 'Gain a Curse.')];
        var dec = new dom.Decision(o, opts, 'Choose what to do for Torturer.', []);
        p.game_.decision(dec, function(key) {
            if(key == 'curse') {
                o.buyCard(p.game_.indexInKingdom('Curse'), true);
                c();
            } else {
                var repeat = function(count) {
                    if(count >= 2) {
                        c();
                        return;
                    }

                    dom.utils.handDecision(o, 'Discard the ' + (count ? 'second card' : 'first of two cards') + ' from your hand.', null, dom.utils.const(true),
                        function(index) {
                            var card = o.hand_[index];
                            o.removeFromHand(index);
                            o.discards_.push(card);
                            o.logMe('discards ' + card.name + '.');
                            repeat(count+1);
                        }, dom.utils.nullFunction);
                };

                repeat(0);
            }
        });
    })
]);


dom.cards['Trading Post'] = new dom.card('Trading Post', { 'Action': 1 }, 5, 'Trash 2 cards from your hand. If you do, gain a Silver card; put it into your hand.', [
    function(p, c) {
        var repeat = function(count) {
            if(count > 1) {
                var bought = p.buyCard(p.game_.indexInKingdom('Silver'), true);
                if(bought) {
                    p.logMe('puts the Silver in his hand.');
                    p.hand_.push(p.discards_.pop());
                }
                c();
                return;
            }

            if(!p.hand_.length) {
                p.logMe('has run out of cards in hand.');
                c();
                return;
            }

            dom.utils.handDecision(p, 'Choose the ' + (count ? 'second card' : 'first of two cards') + ' to trash.', null, dom.utils.const(true), function(index) {
                var card = p.hand_[index];
                p.removeFromHand(index);
                p.logMe('trashes ' + card.name + '.');
                repeat(count+1);
            }, dom.utils.nullFunction);
        };

        repeat(0);
    }
]);


dom.cards['Tribute'] = new dom.card('Tribute', { 'Action': 1 }, 5, 'The player to your left reveals then discards the top 2 cards of his deck. For each differently named card revealed, if it is an: Action card, +2 Actions; Treasure card, +2 Coin; Victory card, +2 Cards.', [
    function(p, c) {
        var leftIndex = p.game_.players.length - 1;
        for(var i = 1; i < p.game_.players.length; i++) { // yes, starting at 1
            leftIndex = i-1;
            if(p.game_.players[i].id_ == p.id_) {
                break;
            }
        }
        var o = p.game_.players[leftIndex];

        var drawn = o.draw(2);
        var cards = [];
        for(var i = 0; i < drawn; i++) {
            cards.push(o.hand_.pop());
        }

        o.logMe('reveals ' + dom.utils.showCards(cards));
        var uniq = cards.unique(function(x,y) { return x.name == y.name; });

        for(var i = 0; i < uniq.length; i++) {
            if(uniq[i].types['Action']) {
                rules.plusActions(2)(p, dom.utils.nullFunction);
            }
            if(uniq[i].types['Treasure']) {
                rules.plusCoin(2)(p, dom.utils.nullFunction);
            }
            if(uniq[i].types['Victory']) {
                rules.plusCards(2)(p, dom.utils.nullFunction);
            }
        }
        c();
    }
]);


dom.cards['Upgrade'] = new dom.card('Upgrade', { 'Action': 1 }, 5, '+1 Card, +1 Action. Trash a card from your hand. Gain a card costing exactly 1 Coin more than it.', [
    rules.plusCards(1),
    rules.plusActions(1),
    function(p, c) {
        dom.utils.handDecision(p, 'Choose a card to trash.', null, dom.utils.const(true), function(index) {
            var card = p.hand_[index];
            p.removeFromHand(index);
            p.logMe('trashes ' + card.name + '.');

            var exactCost = p.game_.cardCost(card) + 1;

            var eligible = p.game_.kingdom
                            .filter(function(c) { return c.count > 0; })
                            .map(function(c) { return c.card; })
                            .filter(function(c) { return p.game_.cardCost(c) == exactCost; });

            if(!eligible.length) {
                p.logMe('gains nothing; there are no cards that cost exactly ' + exactCost + '.');
                c();
                return;
            }
            
            dom.utils.gainCardDecision(p, 'Gain a card costing exactly ' + exactCost + ' Coin.', null, [], function(c) { return p.game_.cardCost(c) == exactCost; }, function(repeat) {
                return dom.utils.decisionHelper(dom.utils.nullFunction, function(index) {
                    p.buyCard(index, true);
                    c();
                }, repeat);
            });

        }, dom.utils.nullFunction);
    }
]);


dom.cards['Harem'] = new dom.card('Harem', { 'Treasure': 1, 'Victory': 1 }, 6, '2 Coin. 2 VP.', []);

dom.cards['Nobles'] = new dom.card('Nobles', { 'Action': 1, 'Victory': 1 }, 6, '2 VP. Choose one: +3 Cards, or +2 Actions.', [
    function(p, c) {
        var opts = [new dom.Option('cards', '+3 Cards'), new dom.Option('actions', '+2 Actions')];
        var dec = new dom.Decision(p, opts, 'Choose one option for your Nobles.', []);
        p.game_.decision(dec, function(key) {
            if(key == 'cards') {
                rules.plusCards(3)(p, c);
            } else {
                rules.plusActions(2)(p, c);
            }
        });
    }
]);


dom.cards.starterDeck = function() {
	return [
		dom.cards['Copper'],
		dom.cards['Copper'],
		dom.cards['Copper'],
		dom.cards['Copper'],
		dom.cards['Copper'],
		dom.cards['Copper'],
		dom.cards['Copper'],
		dom.cards['Estate'],
		dom.cards['Estate'],
		dom.cards['Estate']
	];
};


dom.cards.drawKingdom = function() {
	var all = [
        // Base
		dom.cards['Cellar'],
		dom.cards['Chapel'],
		dom.cards['Moat'],
		dom.cards['Chancellor'],
		dom.cards['Village'],
		dom.cards['Woodcutter'],
		dom.cards['Workshop'],
		dom.cards['Bureaucrat'],
		dom.cards['Feast'],
		dom.cards['Gardens'],
		dom.cards['Militia'],
		dom.cards['Moneylender'],
		dom.cards['Remodel'],
		dom.cards['Smithy'],
		dom.cards['Spy'],
		dom.cards['Thief'],
		dom.cards['Throne Room'],
		dom.cards['Council Room'],
		dom.cards['Festival'],
		dom.cards['Laboratory'],
		dom.cards['Library'],
		dom.cards['Market'],
		dom.cards['Mine'],
		dom.cards['Witch'],
		dom.cards['Adventurer'],

        // Seaside
        dom.cards['Embargo'],
        dom.cards['Haven'],
        dom.cards['Lighthouse'],
        dom.cards['Native Village'],
        dom.cards['Pearl Diver'],
        dom.cards['Ambassador'],
        dom.cards['Fishing Village'],
        dom.cards['Lookout'],
        dom.cards['Smugglers'],
        dom.cards['Warehouse'],
        dom.cards['Caravan'],
        dom.cards['Cutpurse'],
        dom.cards['Island'],
        dom.cards['Navigator'],
        dom.cards['Pirate Ship'],
        dom.cards['Salvager'],
        dom.cards['Sea Hag'],
        dom.cards['Treasure Map'],
        dom.cards['Bazaar'],
        dom.cards['Explorer'],
        dom.cards['Ghost Ship'],
        dom.cards['Merchant Ship'],
        dom.cards['Outpost'],
        dom.cards['Tactician'],
        dom.cards['Treasury'],
        dom.cards['Wharf'],

        // Intrigue
        dom.cards['Courtyard'],
        dom.cards['Pawn'],
        dom.cards['Secret Chamber'],
        dom.cards['Great Hall'],
        dom.cards['Masquerade'],
        dom.cards['Shanty Town'],
        dom.cards['Steward'],
        dom.cards['Swindler'],
        dom.cards['Wishing Well'],
        dom.cards['Baron'],
        dom.cards['Bridge'],
        dom.cards['Conspirator'],
        dom.cards['Coppersmith'],
        dom.cards['Ironworks'],
        dom.cards['Mining Village'],
        dom.cards['Scout'],
        dom.cards['Duke'],
        dom.cards['Minion'],
        dom.cards['Saboteur'],
        dom.cards['Torturer'],
        dom.cards['Trading Post'],
        dom.cards['Tribute'],
        dom.cards['Upgrade'],
        dom.cards['Harem'],
        dom.cards['Nobles'],
	];

	var drawn = [];
	while(drawn.length < 10) {
		var n = Math.floor(Math.random() * all.length);
		if(drawn.filter(function(c) { return c == n; }).length == 0) {
			drawn.push(n);
		}
	}

    var cards = drawn.map(function(n) { return all[n]; });
    cards.sort(function(a,b) {
        costDiff = a.cost - b.cost;
        if(costDiff != 0) {
            return costDiff;
        } else {
            if(a.name < b.name) {
                return -1;
            } else if(a.name > b.name){
                return 1;
            } else {
                // can't happen
                console.log("ERROR: drew two copies of the same card");
                process.exit(1);
            }
        }
    });

	return cards;
};

dom.cards.treasureValues = {
	'Gold': 3,
	'Silver': 2,
	'Copper': 1,
    'Harem': 2,
};

dom.cards.victoryValues = {
	'Estate': 1,
	'Duchy': 3,
	'Province': 6,
	'Island': 2,
    'Great Hall': 1,
    'Nobles': 2,
    'Harem': 2,
};

dom.cards.cardCount = function(card, players) {
	if(card.types['Victory']) {
		return players == 2 ? 8 : 12;
	} else if(card.name == 'Curse') {
		if(players == 2) return 10;
		else if(players == 3) return 20;
		else return 30;
	}
	return 10;
};

// converts cards to wire format (by removing the rules, basically)
dom.cards.wireCards = function(cards) {
	var ret = [];
	for(var i = 0; i < cards.length; i++) {
		ret.push({ name: cards[i].card.name, types: cards[i].card.types, cost: cards[i].card.cost, text: cards[i].card.text, count: cards[i].count });
	}
	return ret;
}

// the kingdom cards

//#		Card			Set	Card Type				Cost	Rules
//1		*Cellar			Base	Action				$2	+1 Action, Discard any number of cards. +1 Card per card discarded.
//2		*Chapel			Base	Action				$2	Trash up to 4 cards from your hand.
//3		*Moat			Base	Action - Reaction	$2	+2 Cards, When another player plays an Attack card, you may reveal this from your hand. If you do, you are unaffected by that Attack.
//4		*Chancellor		Base	Action				$3	+2 Coins, You may immediately put your deck into your discard pile.
//5		*Village		Base	Action				$3	+1 Card, +2 Actions.
//6		*Woodcutter		Base	Action				$3	+1 Buy, +2 Coins.
//7		*Workshop		Base	Action				$3	Gain a card costing up to 4 Coins.
//8		*Bureaucrat		Base	Action - Attack		$4	Gain a silver card; put it on top of your deck. Each other player reveals a Victory card from his hand and puts it on his deck (or reveals a hand with no Victory cards).
//9		*Feast			Base	Action				$4	Trash this card. Gain a card costing up to 5 Coins.
//10	*Gardens		Base	Victory				$4	Variable, Worth 1 Victory for every 10 cards in your deck (rounded down).
//11	*Militia		Base	Action - Attack		$4	+2 Coins, Each other player discards down to 3 cards in his hand.
//12	*Moneylender	Base	Action				$4	Trash a Copper from your hand. If you do, +3 Coins.
//13	*Remodel		Base	Action				$4	Trash a card from your hand. Gain a card costing up to 2 Coins more than the trashed card.
//14	*Smithy			Base	Action				$4	+3 Cards.
//15	*Spy			Base	Action - Attack		$4	+1 Card, +1 Action, Each player (including you) reveals the top card of his deck and either discards it or puts it back, your chouce.
//16	*Thief			Base	Action - Attack		$4	Each other player reveals the top 2 cards of his deck. If they revealed any Treasure cards, they trash one of them that you choose. You may gain any or all of these trashed cards. They discard the other revealed cards.
//17	*Throne Room	Base	Action				$4	Choose an Action card in your hand. Play it twice.
//18	*Council Room	Base	Action				$5	+4 Cards, +1 Buy, Each other player draws a card.
//19	*Festival		Base	Action				$5	+2 Actions, +1 Buy, +2 Coins.
//20	*Laboratory		Base	Action				$5	+2 Cards, +1 Action.
//21	*Library		Base	Action				$5	Draw until you have 7 cards in hand. You may set aside any Action cards drawn this way, as you draw them; discard the set aside cards after you finish drawing.
//22	*Market			Base	Action				$5	+1 Card, +1 Action, +1 Buy, +1 Coin.
//23	*Mine			Base	Action				$5	Trash a Treasure card from your hand. Gain a Treasure card costing up to 3 Coins more; put it into your hand.
//24	*Witch			Base	Action - Attack		$5	+2 Cards, Each other player gains a Curse card.
//25	*Adventurer		Base	Action				$6	Reveal cards from your deck until you reveal 2 Treasure cards. Put those Treasure cards in your hand and discard the other revealed cards.

// Seaside
//1		*Embargo		Seaside	Action				$2	+2 Coins, Trash this card. Put an Embargo token on top of a Supply pile. - When a player buys a card, he gains a Curse card per Embargo token on that pile.
//2		*Haven			Seaside	Action - Duration	$2	+1 Card, +1 Action, Set aside a card from your hand face down. At the start of your next turn, put it into your hand.
//3		*Lighthouse		Seaside	Action - Duration	$2	+1 Action, Now and at the start of your next turn: +1 Coin. - While this is in play, when another player plays an Attack card, it doesn't affect you.
//4		*Native Village	Seaside	Action				$2	+2 Actions, Choose one: Set aside the top card of your deck face down on your Native Village mat; or put all the cards from your mat into your hand. You may look at the cards on your mat at any time; return them to your deck at the end of the game.
//5		*Pearl Diver	Seaside	Action				$2	+1 Card, +1 Action, Look at the bottom card of your deck. You may put it on top.
//6		*Ambassador		Seaside	Action - Attack		$3	Reveal a card from your hand. Return up to 2 copies of it from your hand to the Supply. Then each other player gains a copy of it.
//7		*Fishing VillageSeaside	Action - Duration	$3	+2 Actions, +1 Coin, At the start of your next turn: +1 Action, +1 Coin.
//8		*Lookout		Seaside	Action				$3	+1 Action, Look at the top 3 cards of your deck. Trash one of them. Discard one of them. Put the other one on top of your deck.
//9		*Smugglers		Seaside	Action				$3	Gain a copy of a card costing up to 6 Coins that the player to your right gained on his last turn.
//10	*Warehouse		Seaside	Action				$3	+3 Card, +1 Action, Discard 3 cards.
//11	*Caravan		Seaside	Action - Duration	$4	+1 Card, +1 Action. At the start of your next turn, +1 Card.
//12	*Cutpurse		Seaside	Action - Attack		$4	+2 Coins, Each other player discards a Copper card (or reveals a hand with no Copper).
//13	*Island			Seaside	Action - Victory	$4	Set aside this and another card from your hand. Return them to your deck at the end of the game. 2 VP.
//14	Navigator		Seaside	Action				$4	+2 Coins, Look at the top 5 cards of your deck. Either discard all of them, or put them back on top of your deck in any order.
//15	Pirate Ship		Seaside	Action - Attack		$4	Choose one: Each other player reveals the top 2 cards of his deck, trashes a revealed Treasure that you choose, discards the rest, and if anyone trashed a Treasure you take a Coin token; or, +1 Coin per Coin token you've taken with Pirate Ships this game.
//16	Salvager		Seaside	Action				$4	+1 Buy, Trash a card from your hand. +Coins equal to its cost.
//17	Sea Hag			Seaside	Action - Attack		$4	Each other player discards the top card of his deck, then gains a Curse card, putting it on top of his deck.
//18	Treasure Map	Seaside	Action				$4	Trash this and another copy of Treasure Map from your hand. If you do trash two Treasure Maps, gain 4 Gold cards, putting them on top of your deck.
//19	Bazaar			Seaside	Action				$5	+1 Card, +2 Actions, +1 Coin.
//20	Explorer		Seaside	Action				$5	You may reveal a Province card from your hand. If you do, gain a Gold card, putting it into your hand. Otherwise, gain a Silver card, putting it into your hand.
//21	Ghost Ship		Seaside	Action - Attack		$5	+2 Card, Each other player with 4 or more cards in hand puts cards from his hand on top of his deck until he has 3 cards in his hand.
//22	Merchant Ship	Seaside	Action - Duration	$5	Now and at the start of your next turn: +2 Coins.
//23	Outpost			Seaside	Action - Duration	$5	You only draw 3 cards (instead of 5) in this turn's Clean-up phase. Take an extra turn after this one. This can't cause you to take more than two consecutive turns.
//24	Tactician		Seaside	Action - Duration	$5	Discard your hand. If you discarded any cards this way, then at the start of your next turn, +5 Cards, +1 Buy, and +1 Action.
//25	Treasury		Seaside	Action				$5	+1 Card, +1 Action, +1 Coin, When you discard this from play, if you didn't buy a Victory card this turn, you may put this on top of your deck.
//26	Wharf			Seaside	Action - Duration	$5	Now and at the start of your next turn: +2 Cards, +1 Buy.

// Intrigue
//1     Courtyard       Intrigue	Action	        $2	+3 Card, Put a card from your hand on top of your deck.
//2     Pawn            Intrigue	Action	        $2	Choose two: +1 Card, +1 Action, +1 Buy, +1 Coin. (The choices must be different.).
//3     Secret Chamber  Intrigue	Action - Reaction	$2	Discard any number of cards. +1 Coin per card discarded. - When another player plays an Attack card, you may reveal this from your hand. If you do, +2 cards, then put 2 cards from your hand on top of your deck.
//4     Great Hall      Intrigue	Action - Victory	$3	1 Victory, +1 Card, +1 Action.
//5     Masquerade      Intrigue	Action	        $3	+2 Card, Each player passes a card in their hand to the player on their left. You may trash a card from your hand.
//6     Shanty Town     Intrigue	Action	        $3	+2 Actions, Reveal your hand. If you have no Action cards in hand, +2 Cards.
//7     Steward         Intrigue	Action	        $3	Choose one: +2 Cards; or +2 Coins; or trash 2 cards from your hand.
//8     Swindler        Intrigue	Action - Attack	$3	+2 Coins, Each other player trashes the top card of his deck and gains a card with the same cost that you choose.
//9     Wishing Well    Intrigue	Action	        $3	+1 Card, +1 Action, Name a card, then reveal the top card of your deck. If it is the named card, put it in your hand.
//10    Baron           Intrigue	Action	        $4	+1 Buy, You may discard an Estate card. If you do, +4 Coins. Otherwise, gain an Estate card.
//11    Bridge          Intrigue	Action	        $4	+1 Buy, +1 Coin. All cards (including cards in players' hands) cost 1 Coin less this turn, but not less than 0 Coins.
//12    Conspirator     Intrigue	Action	        $4	+2 Coins. If you've played 3 or more Actions this turn (counting this): +1 Card, +1 Action.
//13    Coppersmith     Intrigue	Action	        $4	Copper produces an extra 1 Coin this turn.
//14    Ironworks       Intrigue	Action	        $4	Gain a card costing up to 4 Coins. If it is an... Action card, +1 Action. Treasure card, +1 Coin. Victory card, +1 Card.
//15    Mining Village  Intrigue	Action	        $4	+1 Card, +2 Actions. You may trash this card immediately. If you do, +2 Coins.
//16    Scout           Intrigue	Action	        $4	+1 Action. Reveal the top 4 cards of your deck. Put the revealed Victory cards into your hand. Put the other cards on top of your deck in any order.
//17    Duke            Intrigue	Victory	        $5	Worth 1 Victory per Duchy you have.
//18    Minion          Intrigue	Action - Attack	$5	+1 Action, Choose one: +2 Coins; or discard your hand, +4 Cards, and each other player with at least 5 cards in hand discards his hand and draws 4 cards.
//19    Saboteur        Intrigue	Action - Attack	$5	Each other player reveals cards from the top of his deck until revealing one costing 3 Coins or more. He trashes that card and may gain a card costing at most 2 Coins less than it. He discards the other revealed cards.
//20    Torturer        Intrigue	Action - Attack	$5	+3 Card, Each other player chooses one: he discards 2 cards; or he gains a Curse card, putting it in his hand.
//21    Trading Post    Intrigue	Action	        $5	Trash 2 cards from your hand. If you do, gain a silver card; put it into your hand.
//22    Tribute         Intrigue	Action	        $5	The player to your left reveals then discards the top 2 cards of his deck. For each differently named card revealed, if it is an... Action Card, +2 Actions; Treasure Card, +2 Coins; Victory Card, +2 Cards.
//23    Upgrade         Intrigue	Action	        $5	+1 Card, +1 Action, Trash a card from your hand. Gain a card costing exactly 1 Coin more than it.
//24    Harem           Intrigue	Treasure - Victory	$6	2 Coins, 2 Victory.
//25    Nobles          Intrigue	Action - Victory	$6	2 Victory, Choose one: +3 Cards, or +2 Actions.


exports.cards = dom.cards;
exports.card = dom.card;


