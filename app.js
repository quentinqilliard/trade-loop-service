#!/usr/bin/env node
"use strict";

const http = require("http");
const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const TradeOfferManager = require('steam-tradeoffer-manager');
const SteamTotp = require('steam-totp');

console.log('==============================================');
console.log('   Data Exchange Pipeline - Safe & Stable 24/7');
console.log('==============================================\n');

require("dotenv").config();

// Konfiguraatiot ja vakiot malliesimerkin mukaisesti (millisekunteina)
const CYCLE_DELAY_MS = 15000;          // Tauko onnistuneiden syklirundien välillä (Rate limit -suoja)
const CYCLE_RETRY_WAIT_MS = 5000;       // Perusodotus yleisen virheen sattuessa
const STEAM_ERROR_BASE_WAIT_MS = 10000; // Alkuviive Steamin tilapäisille häiriöille (kertautuu)
const LONG_COOLDOWN_MS = 60000;         // Pitkä jäähdytys, jos virheitä tulee liikaa putkeen
const MAX_CONSECUTIVE_FAILURES = 5;     // Maksimimäärä peräkkäisiä virheitä ennen inventaarion tarkistusta

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
let loopRunning = false;

// Alustetaan Steam-oliot
for (let i = 0; i < 2; i++) {
    bots[i] = new SteamUser();
    communities[i] = new SteamCommunity();
    managers[i] = new TradeOfferManager({
        steam: bots[i],
        community: communities[i],
        language: 'en'
    });
}

// Yksinkertainen HTTP-palvelin pitämään alustan (esim. Render/Heroku) käynnissä
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Exchange Node: ACTIVE\n");
}).listen(PORT, () => {
    console.log(`System Boundary: Bound interface actively listening on port ${PORT}`);
});

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Tunnistetaan Steamin tilapäiset virheet (EResult-koodit virheviesteissä)
function isSteamTransientError(message) {
    return (
        message.includes('(26)') || // Timeout
        message.includes('(11)') || // InvalidState
        message.includes('(16)') || // Busy
        message.includes('(20)') || // ServiceUnavailable
        message.includes('Please try again later')
    );
}

// Rekisteröidään tapahtumakuuntelijat VAIN KERRAN globaalisti
for (let i = 0; i < 2; i++) {
    bots[i].on('loggedOn', () => {
        console.log(`[Tili ${i + 1}] Kirjauduttu sisään tietoverkkoon.`);
    });

    bots[i].on('webSession', (sessionID, cookies) => {
        managers[i].setCookies(cookies, (err) => {
            if (err) {
                console.error(`[Tili ${i + 1}] Evästeiden asennus epäonnistui:`, err.message);
                return;
            }
            communities[i].setCookies(cookies);
            loggedIn[i] = true;
            console.log(`[Tili ${i + 1}] Solmu ja istuntoevästeet valmiina.`);

            if (loggedIn[0] && loggedIn[1] && !loopRunning) {
                loopRunning = true;
                console.log('--- Molemmat päätepisteet aktiivisia! Aloitetaan siirtosilmukka ---');
                runTradeLoop();
            }
        });
    });
    
    bots[i].on('error', (err) => {
        console.error(`[Tili ${i + 1}] Steam-yhteysvirhe: ${err.message}`);
        loggedIn[i] = false;
    });
}

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
}

// Käynnistetään kirjautumiset
login(0, config.accountA);
login(1, config.accountB);

/* --- APUFUNKTIOT TRADEN KÄSITTELYYN --- */

async function getInventoryWithRetry(manager, appId, contextId) {
    return new Promise((resolve, reject) => {
        manager.getInventoryContents(appId, contextId, true, (err, inv) => {
            if (err) return reject(err);
            resolve(inv);
        });
    });
}

async function sendTradeOffer(manager, tradeUrl, item) {
    const offer = manager.createOffer(tradeUrl);
    offer.addMyItem(item);
    offer.setMessage('Automaattinen datapaketin siirtosilmukka.');
    
    return new Promise((resolve, reject) => {
        offer.send((err) => {
            if (err) return reject(err);
            resolve(offer);
        });
    });
}

async function confirmOfferWithRetry(community, identitySecret, offerId) {
    return new Promise((resolve, reject) => {
        community.acceptConfirmationForObject(identitySecret, offerId, (err) => {
            if (err) return reject(err);
            resolve();
        });
    });
}

async function acceptIncomingOffer(manager, offerId) {
    // Haetaan tarjous uudelleen vastaanottajan managerilla id:n perusteella
    const offer = await new Promise((resolve, reject) => {
        manager.getOffer(offerId, (err, off) => {
            if (err) return reject(err);
            resolve(off);
        });
    });

    return new Promise((resolve, reject) => {
        offer.accept((err, status) => {
            if (err) return reject(err);
            resolve(status);
        });
    });
}

/* --- PÄÄSIIRTOSILMUKKA (Vastaa uutta arkkitehtuuria) --- */

async function runTradeLoop() {
    let currentHolderIdx = 0;
    let currentReceiverIdx = 1;
    let targetAssetId = null;
    let cycleCount = 0;
    let consecutiveFailures = 0;

    while (loopRunning) {
        try {
            // Jos kohde-esinettä ei ole määritetty tai takana on virheitä, tarkistetaan inventaariot
            if (!targetAssetId) {
                console.log('Alustetaan siirrettävä esine inventaariosta...');
                const invA = await getInventoryWithRetry(managers[0], config.appId, config.contextId);
                const invB = await getInventoryWithRetry(managers[1], config.appId, config.contextId);

                if (invA && invA.length > 0) {
                    targetAssetId = invA[0].id;
                    currentHolderIdx = 0;
                    currentReceiverIdx = 1;
                } else if (invB && invB.length > 0) {
                    targetAssetId = invB[0].id;
                    currentHolderIdx = 1;
                    currentReceiverIdx = 0;
                } else {
                    throw new Error('Molemmat inventaariot ovat tyhjiä! Odotetaan tavaroita.');
                }
                console.log(`Esine valittu! AssetID: ${targetAssetId} paikassa Tili ${currentHolderIdx + 1}`);
            }

            cycleCount++;
            console.log(`\n--- Sykli #${cycleCount}: Tili ${currentHolderIdx + 1} → Tili ${currentReceiverIdx + 1} [AssetID=${targetAssetId}] ---`);

            // Vaihe 1: Lähetetään tarjous esineenhaltijan puolelta
            const activeManager = managers[currentHolderIdx];
            const targetTradeUrl = currentReceiverIdx === 1 ? config.accountB.tradeUrl : config.accountA.tradeUrl;
            
            const dummyItem = { id: targetAssetId, appid: config.appId, contextid: config.contextId };
            const offer = await sendTradeOffer(activeManager, targetTradeUrl, dummyItem);
            const offerId = offer.id;
            console.log(`Tarjous lähetetty matkaan. ID: ${offerId}. Aloitetaan mobiilivahvistus...`);

            // Vaihe 2: Mobiilivahvistus (2FA) esineenhaltijan puolelta
            const activeCommunity = communities[currentHolderIdx];
            const identitySecret = currentHolderIdx === 0 ? config.accountA.identitySecret : config.accountB.identitySecret;
            await confirmOfferWithRetry(activeCommunity, identitySecret, offerId);
            console.log(`[Turvavahvistus] Tarjous ${offerId} kuitattu 2FA-tunnuksella.`);

            // Vaihe 3: Vastaanottaja hyväksyy tarjouksen
            console.log(`Pyydetään kohdetta (Tili ${currentReceiverIdx + 1}) hyväksymään tarjous...`);
            await acceptIncomingOffer(managers[currentReceiverIdx], offerId);
            console.log(`[Vastaanottaja] Tarjous ${offerId} hyväksytty onnistuneesti.`);

            // Etsitään uusi assetid vastaanottajan puolelta, koska id muuttuu aina trade-tapahtumassa
            await wait(2000); // Lyhyt odotus, jotta Steam päivittää inventaarion siirron jälkeen
            const receiverInv = await getInventoryWithRetry(managers[currentReceiverIdx], config.appId, config.contextId);
            
            // Haetaan siirretty esine (etsitään esim. saman classid:n tai muiden tietojen pohjalta, tai poimitaan listan kärki)
            if (receiverInv && receiverInv.length > 0) {
                // Koska kyseessä on ping-pong -silmukka yhdellä/samoilla esineillä, otetaan uusi id suoraan ensimmäisestä
                targetAssetId = receiverInv[0].id;
            } else {
                targetAssetId = null; // Pakottaa täyden uudelleentarkistuksen seuraavalla kierroksella
            }

            console.log(`✅ Sykli #${cycleCount} valmis! Tavaroiden uusi AssetID: ${targetAssetId}`);
            consecutiveFailures = 0;

            // Roolien vaihto seuraavaa kierrosta varten (Ping-Pong)
            const prevHolder = currentHolderIdx;
            // Roolien vaihto seuraavaa kierrosta varten (Ping-Pong)
            const prevHolder = currentHolderIdx;
            currentHolderIdx = currentReceiverIdx;
            currentReceiverIdx = prevHolder;

            // Turvallinen viive syklitapahtumien välillä
            console.log(`Odotetaan ${CYCLE_DELAY_MS / 1000}s ennen seuraavaa sykliä...`);
            await wait(CYCLE_DELAY_MS);

        } catch (err) {
            const message = err.message || String(err);
            console.error(`❌ Sykli epäonnistui virheeseen: ${message}`);

            if (message.includes('429') || message.includes('Rate limit')) {
                console.error('🛑 Steamin Rate Limit havaittu! Pysäytetään botti IP-bannien välttämiseksi.');
                loopRunning = false;
                break;
            }

            consecutiveFailures++;
            targetAssetId = null; // Nollataan assetid virheen sattuessa, jotta inventaariot skannataan uudelleen

            // Jos liikaa peräkkäisiä virheitä, siirrytään pitkään jäähdytykseen
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                console.warn(`⚠️ Olet saavuttanut ${consecutiveFailures} peräkkäistä virhettä. Aloitetaan pitkä jäähdytys (${LONG_COOLDOWN_MS / 1000}s)...`);
                await wait(LONG_COOLDOWN_MS);
                consecutiveFailures = 0;
                continue;
            }

            // Progressiivinen eksponentiaalinen backoff-viive Steamin tilapäisille virheille
            const isSteamError = isSteamTransientError(message);
            const waitMs = isSteamError
                ? STEAM_ERROR_BASE_WAIT_MS * Math.pow(2, Math.min(consecutiveFailures - 1, 3))
                : CYCLE_RETRY_WAIT_MS;

            console.warn(`Odotetaan ${Math.round(waitMs / 1000)}s ennen uutta yritystä (Virheet: ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})...`);
            await wait(waitMs);
        }
    }
}
