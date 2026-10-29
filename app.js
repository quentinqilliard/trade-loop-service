async function startTradeLoop(initialFromIndex, initialToIndex) {
    let fromIndex = initialFromIndex;
    let toIndex = initialToIndex;

    console.log('\n--- KÄYNNISTETÄÄN AUTOMAATTINEN SIIRTOSILMUKKA (24/7) ---');

    while (true) {
        try {
            console.log(`\n[Kierros] Tili ${fromIndex + 1} -> Tili ${toIndex + 1}`);

            const inventory = await getInventoryWithRetry(managers[fromIndex], config.appId, config.contextId);

            if (!inventory || inventory.length === 0) {
                console.log(`[Tili ${fromIndex + 1}] Reppu on tyhjä. Vaihdetaan suuntaa lennosta...`);
                await wait(1000); // Lyhyt odotus ennen suunnanvaihtoa
                
                // Vaihdetaan indeksit päittäin ja hypätään seuraavaan kierrokseen
                const temp = fromIndex;
                fromIndex = toIndex;
                toIndex = temp;
                continue; 
            }

            const yksittainenEsine = inventory[0];
            console.log(`Löytyi ${inventory.length} esinettä tililtä ${fromIndex + 1}. Valittu siirtoon ID: ${yksittainenEsine.id}`);

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

            console.log(`Tarjous lähetetty! ID: ${offerId}. Aloitetaan mobiilivahvistus...`);

            const senderIdentitySecret = fromIndex === 0 ? config.accountA.identitySecret : config.accountB.identitySecret;
            await wait(500); 
            await confirmOfferWithRetry(communities[fromIndex], senderIdentitySecret, offerId);

            console.log(`Pyydetään vastaanottajaa (Tili ${toIndex + 1}) hyväksymään tarjous...`);
            await acceptOfferWithRetry(managers[toIndex], offerId);

            console.log(`✅ Esine siirretty onnistuneesti!`);
            
            // Suunnanvaihto onnistuneen kierroksen jälkeen
            const temp = fromIndex;
            fromIndex = toIndex;
            toIndex = temp;

            // Tasapainotettu 2 sekunnin lepotila ennen uutta kierrosta
            await wait(2000); 

        } catch (err) {
            console.error(`❌ Kriittinen virhe siirtosilmukassa: ${err.message}`);
            
            // Jos Steam pätkii, pidetään 15 sekunnin tauko. 
            // Silmukka EI vaihda suuntaa virheen sattuessa, vaan yrittää samaa uudestaan.
            const errorWaitTime = 15000; 
            console.log(`⚠️ Odotetaan ${errorWaitTime / 1000}s ennen uutta yritystä...`);
            await wait(errorWaitTime);
        }
    }
}
