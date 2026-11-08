#!/usr/bin/env node
"use strict";

const http = require("http");
const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const TradeOfferManager = require('steam-tradeoffer-manager');
const SteamTotp = require('steam-totp');

console.log('=== Data Exchange Pipeline - Safe & Secure Mode ===\n');
require("dotenv").config();

const config = {
    appId: parseInt(process.env.TARGET_APP_ID) || 440,
    contextId: parseInt(process.env.TARGET_CONTEXT_ID) || 2,
    accountA: {
        username: process.env.BOT_A_USER, password: process.env.BOT_A_PASS,
        sharedSecret: process.env.BOT_A_SHARED, identitySecret: process.env.BOT_A_IDENTITY,
        tradeUrl: process.env.BOT_A_TRADEURL
    },
    accountB: {
        username: process.env.BOT_B_USER, password: process.env.BOT_B_PASS,
        sharedSecret: process.env.BOT_B_SHARED, identitySecret: process.env.BOT_B_IDENTITY,
        tradeUrl: process.env.BOT_B_TRADEURL
    }
};

const bots = [];
const communities = [];
const managers = [];
let loggedIn = [false, false];
let loopStarted = false;
let lastTransferredAssetId = null;

for (let i = 0; i < 2; i++) {
    bots[i] = new SteamUser();
    communities[i] = new SteamCommunity();
    managers[i] = new TradeOfferManager({
        steam: bots[i], community: communities[i], language: 'en'
    });

    bots[i].on('loggedOn', () => console.log(`[Tili ${i + 1}] Kirjauduttu Steam-verkkoon.`));
    bots[i].on('webSession', (sessionID, cookies) => {
        managers[i].setCookies(cookies, (err) => {
            if (err) return console.error(`[Tili ${i + 1}] Evästeiden asennus epäonnistui:`, err.message);
            communities[i].setCookies(cookies);
            loggedIn[i] = true;
            console.log(`[Tili ${i + 1}] Solmu ja istuntoevästeet valmiina.`);

            if (loggedIn[0] && loggedIn[1] && !loopStarted) {
                loopStarted = true;
                console.log('--- Molemmat aktiivisia! Aloitetaan siirtosilmukka ---');
                setTimeout(() => startTradeLoop(0, 1), 5000);
            }
        });
    });
    bots[i].on('error', (err) => console.error(`[Tili ${i + 1}] SteamUser virhe: ${err.message}`));
}

const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
	res.writeHead(200, { "Content-Type": "text/plain" });
	res.end("Exchange Node: ACTIVE\n");
}).listen(PORT, () => console.log(`Listening on port ${PORT}`));

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function login(index, accountConfig) {
    if (!accountConfig.username || !accountConfig.password) return console.error(`[Tili ${index + 1}] Virhe: Tunnukset puuttuvat.`);
    const details = { accountName: accountConfig.username, password: accountConfig.password };
    if (accountConfig.sharedSecret) details.twoFactorCode = SteamTotp.generateAuthCode(accountConfig.sharedSecret);
    bots[index].logOn(details);
}

login(0, config.accountA);
login(1, config.accountB);

async function getInventoryWithRetry(manager, appId, contextId, retries = 5) {
    for (let i = 0; i < retries; i++) {
        try {
            console.log(`Haetaan inventaariota... (Yritys ${i + 1}/${retries})`);
            return await new Promise((resolve, reject) => {
                manager.getInventoryContents(appId, contextId, true, (err, inv) => err ? reject(err) : resolve(inv));
            });
        } catch (err) {
            console.warn(`Haku pätki (${err.message}). Odotetaan 7s...`);
            await wait(7000);
        }
    }
    throw new Error('Tietueiden haku epäonnistui.');
}

async function confirmSpecificOfferWithRetry(community, identitySecret, targetOfferId, retries = 5) {
    for (let i = 0; i  {
                community.getConfirmations(time, key, (err, confirmations) => err ? reject(err) : resolve(confirmations));
            });

            if (!confs || confs.length === 0) {
                console.warn(`[Suojaus] Ei odottavia vahvistuksia vielä. Yritys ${i + 1}/${retries}...`);
                continue;
            }

            const myConfirmation = confs.find(conf => String(conf.creator) === String(targetOfferId));
            if (myConfirmation) {
                await new Promise((resolve, reject) => {
                    myConfirmation.respond(time, SteamTotp.getConfirmationKey(identitySecret, time, "allow"), true, (err) => err ? reject(err) : resolve());
                });
                console.log(`[Turvavahvistus] ✅ Siirto ${targetOfferId} kuitattu suojaustunnuksella.`);
                return;
            } else {
                console.warn(`[Suojaus] Vahvistusjono ei sisältänyt tarjousta ${targetOfferId}. Jonossa olleet ${confs.length} muuta kohdetta ohitettiin turvallisuussyistä.`);
            }
        } catch (err) {
            console.warn(`[Turvavahvistus] Yritys ${i + 1}/${retries} epäonnistui: ${err.message}`);
        }
        await wait(5000);
    }
    throw new Error(`Mobiilivahvistus epäonnistui tarjoukselle ${targetOfferId}.`);
}

async function acceptOfferWithRetry(manager, offerId, retries = 5) {
    await wait(5000);
    for (let i = 0; i < retries; i++) {
        try {
            const offer = await new Promise((resolve, reject) => {
                manager.getOffer(offerId, (err, off) => err ? reject(err) : resolve(off));
            });

            if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) return console.log(`[Vastaanottaja] Tarjous ${offerId} on jo hyväksytty.`);
            if (offer.state !== TradeOfferManager.ETradeOfferState.Active) {
                console.warn(`[Vastaanottaja] Epäoptimaalinen tila: ${offer.state}. Odotetaan...`);
                await wait(4000);
                continue;
            }

            await new Promise((resolve, reject) => {
                offer.accept((err) => err ? reject(err) : resolve());
            });
            return console.log(`[Vastaanottaja] Siirto ${offerId} hyväksytty kohteessa.`);
        } catch (err) {
            console.warn(`[Vastaanottaja] Vastaanotto epäonnistui (${i + 1}/${retries}): ${err.message}`);
            await wait(5000);
        }
    }
    throw new Error('Siirron hyväksyminen epäonnistui.');
}

async function startTradeLoop(fromIndex, toIndex) {
    try {
        console.log(`\n--- ALOITETAAN RUN: Tili ${fromIndex + 1} -> Tili ${toIndex + 1} ---`);
        const inventory = await getInventoryWithRetry(managers[fromIndex], config.appId, config.contextId);
        
        if (!inventory || inventory.length === 0) {
            console.log(`[Tili ${fromIndex + 1}] Reppu tyhjä. Vaihdetaan suuntaa 15s kuluttua...`);
            await wait(15000);
            return startTradeLoop(toIndex, fromIndex);
        }

        let valittuEsine = null;
        for (const item of inventory) {
            if (item.id !== lastTransferredAssetId) {
                valittuEsine = item;
                break;
            }
        }

        if (!valittuEsine) {
            console.log(`⚠️ Repussa näkyy vain äsken siirretty esine (${lastTransferredAssetId}). Odotetaan synkronointia 15s...`);
            await wait(15000);
            return startTradeLoop(fromIndex, toIndex);
        }

        console.log(`Valittu siirtoon vakaa esine: ${valittuEsine.id}`);
        const targetTradeUrl = toIndex === 1 ? config.accountB.tradeUrl : config.accountA.tradeUrl;
        if (!targetTradeUrl) throw new Error(`Kohdetilin ${toIndex + 1} Trade URL puuttuu konfiguraatiosta!`);

        const offer = managers[fromIndex].createOffer(targetTradeUrl);
        offer.addMyItem(valittuEsine);
        offer.setMessage('Automaattinen suojattu siirtosilmukka.');

        const offerId = await new Promise((resolve, reject) => {
            offer.send((err) => err ? reject(err) : resolve(offer.id));
        });

        console.log(`Tarjous lähetetty! ID: ${offerId}. Aloitetaan suojauskuittaus...`);
        const senderIdentitySecret = fromIndex === 0 ? config.accountA.identitySecret : config.accountB.accountA ? config.accountA.identitySecret : config.accountB.identitySecret;
        await confirmSpecificOfferWithRetry(communities[fromIndex], senderIdentitySecret, offerId);

        console.log(`Pyydetään kohdetta (Tili ${toIndex + 1}) vahvistamaan vastaanotto...`);
        await acceptOfferWithRetry(managers[toIndex], offerId);

        lastTransferredAssetId = valittuEsine.id;
        console.log(`✅ Esine siirretty! Asetettu AssetID-suojaus arvoon: ${lastTransferredAssetId}`);
        
        console.log('Odotetaan 12 sekuntia ennen suunnanvaihtoa...');
        await wait(12000);
        return startTradeLoop(toIndex, fromIndex);

    } catch (err) {
        console.error(`❌ Kriittinen virhe siirtosilmukassa: ${err.message}`);
        console.log('⚠️ Otetaan 30 sekunnin turva-aikalisä...');
        await wait(30000);
        return startTradeLoop(fromIndex, toIndex);
    }
}
