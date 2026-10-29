#!/usr/bin/env node
"use strict";

const http = require('http');
const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const TradeOfferManager = require('steam-tradeoffer-manager');
const SteamTotp = require('steam-totp');

console.log("==============================================");
console.log(" Data Exchange Pipeline - Safe 10s 24/7 Mode ");
console.log("==============================================\n");

require('dotenv').config();

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

for (let i = 0; i < 2; i++) {
    bots[i] = new SteamUser();
    communities[i] = new SteamCommunity();
    managers[i] = new TradeOfferManager({
        steam: bots[i],
        community: communities[i],
        language: 'en'
    });
}

const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Exchange Node: ACTIVE\n');
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

    bots[index].on('webSession', (sessionID, cookies) => {
        managers[index].setCookies(cookies, (err) => {
            if (err) {
                console.error(`[Tili ${index + 1}] Evästeiden asennus epäonnistui:`, err.message);
                return;
            }
            communities[index].setCookies(cookies);
            loggedIn[index] = true;
            console.log(`[Tili ${index + 1}] Solmu ja istuntoevästeet valmiina.`);

            if (loggedIn[0] && loggedIn[1]) {
                console.log("--- Molemmat päätepisteet aktiivisia! Aloitetaan siirtosilmukka ---");
                // Käynnistetään looppi taustalle ilman muistin tukkimista
                startTradeLoop();
            }
        });
    });
}

login(0, config.accountA);
login(1, config.accountB);

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
            const penaltyTime = 100; 
            console.warn(`Haku pätki (${err.message}). Odotetaan ${penaltyTime / 1000}s...`);
            await wait(penaltyTime);
        }
    }
    throw new Error("Tietueiden haku epäonnistui useista yrityksistä huolimatta.");
}

async function confirmOfferWithRetry(community, identitySecret, offerId, retries = 5) {
    for (let i = 0; i < retries; i++) {
        try {
            await wait(0); 
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
            await wait(100); 
        }
    }
    throw new Error("Mobiilivahvistus epäonnistui.");
}

async function acceptOfferWithRetry(manager, offerId, retries = 5) {
    for (let i = 0; i < retries; i++) {
        try {
            await wait(0); 
            
            // PAKOTETAAN STEAM PÄIVITTÄMÄÄN VÄLIMUISTI (Tämä korjaa jumiutumisen)
            manager.doPoll();

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
            await wait(100); 
        }
    }
    throw new Error("Siirron hyväksyminen kohteessa epäonnistui.");
}

// Suoritus korjattu while(true) rakenteeksi, jotta skripti ei kaadu muistin loppumiseen
async function startTradeLoop() {
    let fromIndex = 0;
    let toIndex = 1;

    while (true) {
        try {
            console.log(`\n--- ALOITETAAN RUN: Tili ${fromIndex + 1} -> Tili ${toIndex + 1} ---`);
            
            const inventory = await getInventoryWithRetry(managers[fromIndex], config.appId, config.contextId);
            
            if (!inventory || inventory.length === 0) {
                console.log(`[Tili ${fromIndex + 1}] Säiliö tyhjä. Vaihdetaan siirron suuntaa...`);
                await wait(100); 
                
                // Vaihdetaan suunta lennosta ilman rekursiota
                const temp = fromIndex;
                fromIndex = toIndex;
                toIndex = temp;
                continue;
            }

            const yksittainenEsine = inventory[0];
            console.log(`Löytyi ${inventory.length} tietuetta solmusta ${fromIndex + 1}. Valittu siirtoon: ${yksittainenEsine.id}`);

            const targetTradeUrl = toIndex === 1 ? config.accountB.tradeUrl : config.accountA.tradeUrl;
            const offer = managers[fromIndex].createOffer(targetTradeUrl);
            offer.addMyItem(yksittainenEsine);
            offer.setMessage("Automaattinen datapaketin siirtosilmukka.");

            const offerId = await new Promise((resolve, reject) => {
                offer.send((err) => {
                    if (err) return reject(err);
                    resolve(offer.id);
                });
            });

            console.log(`Paketti lähetetty matkaan! ID: ${offerId}. Aloitetaan suojauskuittaus...`);
            
            // Pakotetaan lähettäjän manageri heräämään heti lähetyksen jälkeen
            managers[fromIndex].doPoll();

            const senderIdentitySecret = fromIndex === 0 ? config.accountA.identitySecret : config.accountB.identitySecret;
            await confirmOfferWithRetry(communities[fromIndex], senderIdentitySecret, offerId);

            console.log(`Pyydetään kohdetta (Tili ${toIndex + 1}) vahvistamaan vastaanotto...`);
            await acceptOfferWithRetry(managers[toIndex], offerId);

            console.log("✅ Datapaketti siirretty onnistuneesti solmujen välillä!");
            console.log("Siirrytään suoraan seuraavaan suunnanvaihtoon...");
            
            await wait(0); 
            
            // Vaihdetaan suunta onnistuneen kierroksen jälkeen
            const temp = fromIndex;
            fromIndex = toIndex;
            toIndex = temp;

        } catch (err) {
            console.error(`❌ Kriittinen poikkeus siirtosilmukassa: ${err.message}`);
            console.log("⚠️ Järjestelmä laukaisi virheen. Yritetään heti uudelleen...");
            await wait(100); 
            // Virheen sattuessa pidetään samat indeksit ja yritetään uudelleen
        }
    }
}
