#!/usr/bin/env node
// price-bot-node.js
const fetch = require('node-fetch');
const fs    = require('fs');
const path  = require('path');

// — Arquivos de cookies e estado
const COOKIE_FILE = path.join(__dirname,'cookies.json');
const STATE_FILE  = path.join(__dirname,'state.json');

// — Carrega cookies.json
let cookies;
try {
  cookies = JSON.parse(fs.readFileSync(COOKIE_FILE,'utf-8'));
  if (!Array.isArray(cookies)) throw new Error('cookies.json deve ser um array');
} catch (e) {
  console.error('❌ Erro lendo cookies.json:', e.message);
  process.exit(1);
}
const COOKIE_HDR = cookies.map(c=>`${c.name}=${c.value}`).join('; ');

// — Carrega state.json
let state = {};
try {
  state = JSON.parse(fs.readFileSync(STATE_FILE,'utf-8'));
  if (typeof state!=='object' || Array.isArray(state)) throw new Error('state.json deve ser objeto');
} catch {
  console.warn('⚠ state.json inválido ou não existe → iniciando vazio');
  state = {};
}

// === CONFIG ===
const AUTH_TOKEN = process.env.AUTH_TOKEN || "EXAMPLE_AUTH_TOKEN";
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || "https://discord.com/api/webhooks/EXAMPLE/EXAMPLE";
const FEE_RATE        = 0.13;
const MIN_INTERVAL    = 2*60*1000;
const CHECK_INTERVAL  = 60*1000;
const JITTER_MAX      = 3000;

// Seus anúncios
const items = [

  { name:'40',  dropId:21251, anuncioId:15,  userProductId:12345, minPrice:1200.00 }
];

// utilitários
const sleep   = ms=>new Promise(r=>setTimeout(r,ms));
const randInt = (min,max)=>Math.floor(Math.random()*(max-min+1))+min;
const ts      = ()=>new Date().toISOString().substr(11,8);
function headers(type='GET'){
  const h = {
    'accept':'application/json, text/plain, */*',
    'authorization':AUTH_TOKEN,
    'cookie':COOKIE_HDR
  };
  if(type==='PATCH') h['content-type']='application/json;charset=UTF-8';
  return h;
}

// salva state.json
function saveState(){
  const o = {};
  for(const it of items){
    o[it.userProductId] = {
      currentPrice: it.currentPrice,
      lastUpdate: it.lastUpdate
    };
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(o,null,2));
}

// GET produtos no formato Droper
async function fetchProdutos(item){
  const url = `https://service.cataloko.com/api/drops/v6/${item.dropId}/anuncios/${item.anuncioId}`;
  const res = await fetch(url,{ headers: headers() });
  if(!res.ok) throw new Error(`GET/${item.name}→${res.status}`);
  return (await res.json()).novos.produtos;
}

// PATCH preço
async function patchPreco(item,price){
  await sleep(randInt(0,JITTER_MAX));
  const url = `https://service.cataloko.com/api/adm/produto/${item.userProductId}/preco`;
  const res = await fetch(url,{
    method:'PATCH',
    headers: headers('PATCH'),
    body: JSON.stringify({ preco: price.toFixed(2) })
  });
  return { status:res.status, body:await res.text() };
}

// calcula candidato
function calcCandidate(cur,base,minP){
  let cand = base - 0.01;
  if(cur - cand < 0.10) cand = cur - 0.11;
  return Math.max(Math.round(cand*100)/100, minP);
}

// envia embed no Discord
async function sendDiscord({title,color,fields}){
  const embed = { title, color, timestamp:new Date().toISOString(), fields };
  await fetch(DISCORD_WEBHOOK,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ embeds:[embed] })
  });
}

// processa um item
async function processItem(item){
  try {
    const prods = await fetchProdutos(item);
    const cons  = prods
      .filter(p=>p.id!==item.userProductId)
      .map(p=>({ id:p.id, price:parseFloat(p.precof), auth:p.isVendedorAutenticado }));
    const first = prods[0];
    const since = Date.now() - item.lastUpdate;

    console.log(`[${ts()}] [${item.name}] Você: R$${item.currentPrice.toFixed(2)} | 1º exib: #${first.id}@R$${parseFloat(first.precof).toFixed(2)}`);

    // ► Reduzir se houver mais barato
    const cheaper = cons.find(c=>c.price < item.currentPrice);
    if(cheaper && since>=MIN_INTERVAL){
      // fetch fresh antes de calcular
      const fresh = await fetchProdutos(item);
      const freshCheaper = fresh
        .filter(p=>p.id!==item.userProductId)
        .map(p=>parseFloat(p.precof))
        .filter(p=>p<item.currentPrice)
        .sort((a,b)=>a-b)[0];
      const cand = calcCandidate(item.currentPrice, freshCheaper, item.minPrice);

      console.log(` → Reduzindo para R$${cand} (conc: R$${freshCheaper})`);
      const {status,body} = await patchPreco(item,cand);
      if(status>=200&&status<300){
        const d = JSON.parse(body);
        item.currentPrice = parseFloat(d.precof);
        item.lastUpdate   = Date.now();
        saveState();
        console.log(`   ✔ Novo: R$${item.currentPrice.toFixed(2)} | Líq: R$${(item.currentPrice*(1-FEE_RATE)).toFixed(2)}`);
        await sendDiscord({
          title:`📉 [${item.name}] Preço reduzido`,
          color:0xE74C3C,
          fields:[
            { name:'Novo preço',  value:`R$ ${item.currentPrice}`, inline:true },
            { name:'Recebível',   value:`R$ ${(item.currentPrice*(1-FEE_RATE)).toFixed(2)}`, inline:true },
            { name:'Concorrente', value:`R$ ${freshCheaper}`, inline:true }
          ]
        });
      }
      return;
    }

    // ► Empate com verificado
    const tieVer = cons.find(c=>c.price===item.currentPrice && c.auth);
    if(!cheaper && tieVer && since>=MIN_INTERVAL){
      await fetchProdutos(item);
      const cand = calcCandidate(item.currentPrice, item.currentPrice, item.minPrice);
      console.log(` → Empate verificado #${tieVer.id}, reduzindo p/ R$${cand}`);
      const {status,body}=await patchPreco(item,cand);
      if(status>=200&&status<300){
        const d=JSON.parse(body);
        item.currentPrice=parseFloat(d.precof);
        item.lastUpdate=Date.now();
        saveState();
        console.log(`   ✔ Novo: R$${item.currentPrice.toFixed(2)} | Líq: R$${(item.currentPrice*(1-FEE_RATE)).toFixed(2)}`);
        await sendDiscord({
          title:`⚠️ [${item.name}] Empate verificado`,
          color:0xF1C40F,
          fields:[
            { name:'Preço ajustado', value:`R$ ${item.currentPrice}`, inline:true },
            { name:'Recebível',      value:`R$ ${(item.currentPrice*(1-FEE_RATE)).toFixed(2)}`, inline:true }
          ]
        });
      }
      return;
    }

    // ► Elevar se você for 1º
    if(first.id===item.userProductId && since>=MIN_INTERVAL){
      const sec=prods[1];
      if(sec){
        const secP=parseFloat(sec.precof);
        if(secP>item.currentPrice){
          const up=Math.round((secP-0.01)*100)/100;
          console.log(` → Elevando para R$${up}`);
          const {status,body}=await patchPreco(item,up);
          if(status>=200&&status<300){
            const d=JSON.parse(body);
            item.currentPrice=parseFloat(d.precof);
            item.lastUpdate=Date.now();
            saveState();
            console.log(`   ✔ Novo: R$${item.currentPrice.toFixed(2)} | Líq: R$${(item.currentPrice*(1-FEE_RATE)).toFixed(2)}`);
            await sendDiscord({
              title:`📈 [${item.name}] Preço elevado`,
              color:0x2ECC71,
              fields:[
                { name:'Novo preço',  value:`R$ ${item.currentPrice}`, inline:true },
                { name:'Recebível',   value:`R$ ${(item.currentPrice*(1-FEE_RATE)).toFixed(2)}`, inline:true },
                { name:'2º colocado', value:`R$ ${secP}`, inline:true }
              ]
            });
          }
        }
      }
      return;
    }

    console.log(' → sem ação');
  } catch(e){
    console.error(`[${item.name}] erro:`, e.message||e);
  }
}

// — Inicialização: busca o preço real de cada item
async function initPrices(){
  console.log('⏳ Buscando preço inicial de cada anúncio...');
  for(const it of items){
    try {
      const prods = await fetchProdutos(it);
      const me = prods.find(p=>p.id===it.userProductId);
      it.currentPrice = me ? parseFloat(me.precof) : it.minPrice;
      it.lastUpdate   = state[it.userProductId]?.lastUpdate || 0;
      console.log(`  [${it.name}] preço inicial = R$${it.currentPrice.toFixed(2)}`);
    } catch(e){
      console.warn(`  [${it.name}] falha ao obter preço inicial, usando minPrice`);
      it.currentPrice = it.minPrice;
      it.lastUpdate   = 0;
    }
  }
  saveState();
}

// — Função principal
async function main(){
  console.log(`\n[${ts()}] === Iniciando rodada ===`);
  for(const it of items){
    await processItem(it);
    await sleep(randInt(200,800));
  }
}

// start
(async()=>{
  await initPrices();
  await main();
  setInterval(main, CHECK_INTERVAL);
})();
