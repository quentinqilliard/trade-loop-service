#!/usr/bin/env node
"use strict";

const http = require("http");
const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const TradeOfferManager = require('steam-tradeoffer-manager');
const SteamTotp = require('steam-totp');

console.log('==============================================');
console.log('   Data Exchange Pipeline - MAX SPEED 24/7 Mode');
console.log('==============================================\n');

require("dotenv").config();

// Estetään prosessia kaatumasta odottamattomiin taustavirheisiin (esim. katkenneet verkkoyhteydet)
process.on('uncaughtException', (err) => {
    console.error(`[Kriittinen Järjestelmävirhe] Estetty kaatuminen: ${err.message}`);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[Käsittelemätön Rejection] Estetty kaatuminen:', reason);
});

const config = {
    appId: parseInt(process.env.TARGET_APP_ID) || 440,
    contextId: parseInt(process.env.TARGET_CONTEXT_ID) || 2,
    accountA: {
        username: process.env.BOT_A_USER,
        password: process.env.BOT_A_PASS,
        sharedSecret: process.env.BOT_A_SHARED,
        identitySecret: process.env.BOT_A_IDENTITY,
        tradeUrl: process.env.BOT_A_TRADEURL
    },
    accountB: {
        username: process.env.BOT_B_USER,
        password: process.env.BOT_B_PASS,
        sharedSecret: process.env.BOT_B_SHARED,
        identitySecret: process.env.BOT_B_IDENTITY,
        tradeUrl: process.env.BOT_B_TRADEURL
    }
};

const bots = [];
const communities = [];
const managers = [];
let loggedIn = [false, false];
let loopStarted = false; // Varmistetaan, ettei silmukkaa käynnistetä vahingossa useasti

for (let i = 0; i < 2; i++) {
    bots[i] = new SteamUser();
    communities[i] = new SteamCommunity();
    managers[i] = new TradeOfferManager({
        steam: bots[i],
        community: communities[i],
        language: 'en',
        pollInterval: 10000 // NOPEUTETTU: Haetaan päivitykset Steamistã 10s välein oletuksen (30s) sijaan
    });
}

const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
	res.writeHead(200, { "Content-Type": "text/plain" });
	res.end("Exchange Node: ACTIVE\n");
}).listen(PORT, () => {
	console.log(`System Boundary: Bound interface actively listening on port ${PORT}`);
});

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function login(index, accountConfig) {
    if (!accountConfig.username || !accountConfig.password) {
        console.error(`[Tili ${index + 1}] Virhe: Tunnukset puuttuvat muuttujista.`);
        return;
    }
    
    bots[index].logOn({
        accountName: accountConfig.username,
        password: accountConfig.password,
        twoFactorCode: SteamTotp.generateAuthCode(accountConfig.sharedSecret)
    });

    bots[index].on('loggedOn', () => {
        console.log(`[Tili ${index + 1}] Kirjauduttu sisään tietoverkkoon.`);
    });

    // EVÄSTEIDEN AUTOMAATTINEN UUSIMINEN: Jos Steam vanhentaa istunnon, haetaan uusi lennosta
    bots[index].on('sessionExpired', (err) => {
        console.warn(`[Tili ${index + 1}] Istunto vanhentunut (Steam session expired). Uusitaan evästeet lennosta...`);
        loggedIn[index] = false;
        bots[index].webLogOn();
    });

    bots[index].on('webSession', (sessionID, cookies) => {
        managers[index].setCookies(cookies, (err) => {
            if (err) {
                console.error(`[Tili ${index + 1}] Evästeiden asennus epäonnistui:`, err.message);
                return;
            }
            communities[index].setCookies(cookies);
            loggedIn[index] = true;
            console.log(`[Tili ${index + 1}] Solmu ja istuntoevästeet valmiina.`);

            if (loggedIn[0] && loggedIn[1] && !loopStarted) {
                loopStarted = true;
                console.log('--- Molemmat päätepisteet aktiivisia! Aloitetaan siirtosilmukka ---');
                cleanStuckOffers().then(() => {
                    startTradeLoop(0, 1);
                });
            }
        });
    });
}

login(0, config.accountA);
login(1, config.accountB);

// Siivousfunktio jumiutuneille tarjouksille
async function cleanStuckOffers() {
    console.log('[Siivous] Tarkistetaan ja siivotaan mahdolliset jumiutuneet tarjoukset...');
    for (let i = 0; i < 2; i++) {
        try {
            await new Promise((resolve, reject) => {
                managers[i].getOffers(TradeOfferManager.ETradeOfferState.Active, (err, sent, received) => {
                    if (err) return reject(err);
                    
                    let actions = [];
                    
                    sent.forEach(offer => {
                        console.log(`[Siivous] Perutaan jumiutunut lähetetty tarjous #${offer.id}`);
                        actions.push(new Promise(res => offer.cancel(() => res())));
                    });

                    received.forEach(offer => {
                        console.log(`[Siivous] Hylätään jumiutunut vastaanotettu tarjous #${offer.id}`);
                        actions.push(new Promise(res => offer.decline(() => res())));
                    });

                    Promise.all(actions).then(resolve);
                });
            });
        } catch (err) {
            console.warn(`[Siivous] Huomautus: Siivous epäonnistui solmussa ${i + 1}: ${err.message}`);
        }
    }
}

async function getInventoryWithRetry(manager, appId, contextId, retries = 5) {
    for (let i = 0; i < retries; i++) {
        try {
            console.log(`Haetaan lohkon sisältöä... (Yritys ${i + 1}/${retries})`);
            const inventory = await new Promise((resolve, reject) => {
                manager.getInventoryContents(appId, contextId, true, (err, inv) => {
                    if (err) return reject(err);
                    resolve(inv);
                });
            });
            return inventory;
        } catch (err) {
            const penaltyTime = 1500 + (i * 1000); // NOPEUTETTU VIRHEODOTUS: 3000ms -> 1500ms
            console.warn(`Haku pätki (${err.message}). Odotetaan ${penaltyTime / 1000}s...`);
            await wait(penaltyTime);
        }
    }
    throw new Error('Tietueiden haku epäonnistui useista yrityksistä huolimatta.');
}

async function confirmOfferWithRetry(community, identitySecret, offerId, retries = 5) {
    for (let i = 0; i < retries; i++) {
        try {
            await wait(500); // ERITTÄIN NOPEA: 1500ms -> 500ms odotus ennen kuittausta
            await new Promise((resolve, reject) => {
                community.acceptConfirmationForObject(identitySecret, offerId, (err) => {
                    if (err) return reject(err);
                    resolve();
                });
            });
            console.log(`[Turvavahvistus] Siirto ${offerId} kuitattu onnistuneesti suojaustunnuksella.`);
            return;
        } catch (err) {
            console.warn(`[Turvavahvistus] Yritys ${i + 1} epäonnistui: ${err.message}`);
            await wait(1500); // NOPEUTETTU: Virheodotus 3000ms -> 1500ms
        }
    }
    throw new Error('Mobiilivahvistus epäonnistui.');
}

async function acceptOfferWithRetry(manager, offerId, retries = 5) {
    for (let i = 0; i < retries; i++) {
        try {
            await wait(300); // ERITTÄIN NOPEA: 750ms -> 300ms odotus ennen hyväksyntää
            const offer = await new Promise((resolve, reject) => {
                manager.getOffer(offerId, (err, off) => {
                    if (err) return reject(err);
                    resolve(off);
                });
            });

            await new Promise((resolve, reject) => {
                offer.accept((err) => {
                    if (err) return reject(err);
                    resolve();
                });
            });
            console.log(`[Vastaanottaja] Siirto ${offerId} hyväksytty kohteessa.`);
            return;
        } catch (err) {
            console.warn(`[Vastaanottaja] Vastaanotto epäonnistui, yritetään uudelleen: ${err.message}`);
            await wait(1000); // NOPEUTETTU: Virheodotus 2000ms -> 1000ms
        }
    }
    throw new Error('Siirron hyväksyminen kohteessa epäonnistui.');
}

async function startTradeLoop(fromIndex, toIndex) {
    try {
        console.log(`\n--- ALOITETAAN RUN: Tili ${fromIndex + 1} -> Tili ${toIndex + 1} ---`);
        
        const inventory = await getInventoryWithRetry(managers[fromIndex], config.appId, config.contextId);
        
        if (!inventory || inventory.length === 0) {
            console.log(`[Tili ${fromIndex + 1}] Säiliö tyhjä. Vaihdetaan siirron suuntaa 1 sekunnin kuluttua...`);
            await wait(1000); // NOPEUTETTU: Tyhjän repun odotus 3000ms -> 1000ms
            return startTradeLoop(toIndex, fromIndex);
        }

        const yksittainenEsine = inventory[0]; 
        console.log(`Löytyi ${inventory.length} tietuetta solmusta ${fromIndex + 1}. Valittu siirtoon: ${yksittainenEsine.id}`);
        
        const targetTradeUrl = toIndex === 1 ? config.accountB.tradeUrl : config.accountA.tradeUrl;
        const offer = managers[fromIndex].createOffer(targetTradeUrl);
        
        offer.addMyItem(yksittainenEsine);
        offer.setMessage('Automaattinen datapaketin siirtosilmukka.');

        const offerId = await new Promise((resolve, reject) => {
            offer.send((err) => {
                if (err) return reject(err);
                resolve(offer.id);
            });
        });

        console.log(`Paketti lähetetty matkaan! ID: ${offerId}. Aloitetaan suojauskuittaus...`);

        const senderIdentitySecret = fromIndex === 0 ? config.accountA.identitySecret : config.accountB.identitySecret;
        await confirmOfferWithRetry(communities[fromIndex], senderIdentitySecret, offerId);

        console.log(`Pyydetään kohdetta (Tili ${toIndex + 1}) vahvistamaan vastaanotto...`);
        await acceptOfferWithRetry(managers[toIndex], offerId);
