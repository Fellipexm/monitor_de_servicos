/************************************************************
* NOC MONITOR - BACKEND COMPLETO (VERSÃO BLINDADA + SESSÃO ISOLADA ✅)
*
* ✅ MELHORIAS:
* - Global Error Handlers (Não para com erros inesperados)
* - SQLite WAL Mode + Busy Timeout (Evita travamento de banco)
* - WhatsApp Auto-Reconnect (Reconecta se cair)
* - Session cookie com nome único: 'noc.sid' (Isolamento!)
* - Loop de Monitoria protegido contra falhas
* - PM2 Ready (Preparado para gerenciador de processos)
* - Anti-flapping + Threshold editável
************************************************************/
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// ================= TRATAMENTO GLOBAL DE ERROS (CRUCIAL) =================
process.on('uncaughtException', (err) => {
    console.error('❌ [CRASH] Uncaught Exception:', err.message);
    console.error(err.stack);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ [CRASH] Unhandled Rejection at:', promise, 'reason:', reason);
});
process.setMaxListeners(20);

const express = require("express");
const axios = require("axios");
const sqlite3 = require("sqlite3").verbose();
const session = require("express-session");
const fs = require("fs");
const path = require("path");
const https = require("https");
const net = require("net");
const ping = require("ping");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");

// XLSX export (opcional: npm i exceljs)
let ExcelJS = null;
try { ExcelJS = require("exceljs"); } catch { }

// ================= CONFIG =================
const configPath = path.join(__dirname, "config.json");
if (!fs.existsSync(configPath)) {
    console.error("❌ config.json não encontrado.");
    process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

// ================= EXPRESS =================
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ✅ SESSÃO COM COOKIE NOMEADO (ISOLAMENTO COM RAMAIS!)
app.use(session({
    secret: config.sessionSecret || "noc-secret-unique-key-change-in-prod",
    name: 'noc.sid', // ← NOME ÚNICO PARA EVITAR CONFLITO COM OUTROS SISTEMAS!
    resave: false,
    saveUninitialized: true,
    cookie: { 
        maxAge: 1000 * 60 * 60 * 8, // 8 horas
        httpOnly: true,
        secure: false, // Mude para true se usar HTTPS
        sameSite: 'lax'
    }
}));

function auth(req, res, next) {
    if (!req.session.logado) return res.sendStatus(403);
    next();
}

// ================= WHATSAPP =================
let zapPronto = false;
let reconnectTimeout = null;

const zap = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true, // true para produção (economiza RAM)
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    },
});

zap.on("qr", (qr) => {
    console.log("==================================");
    console.log(" ESCANEIE O QR DO WHATSAPP");
    console.log("==================================");
    qrcode.generate(qr, { small: true });
    zapPronto = false;
});

zap.on("ready", () => {
    console.log("✅ WHATSAPP CONECTADO");
    zapPronto = true;
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }
});

zap.on("authenticated", () => console.log("✅ AUTH OK"));

zap.on("auth_failure", (err) => {
    console.log("❌ FALHA AUTH:", err);
    zapPronto = false;
    console.log("⚠️ Tentando reiniciar cliente WhatsApp em 10s...");
    scheduleRestart();
});

zap.on("disconnected", (reason) => {
    console.log("❌ WHATSAPP DESCONECTADO:", reason);
    zapPronto = false;
    console.log("⚠️ Agendando reconexão automática...");
    scheduleRestart();
});

function scheduleRestart() {
    if (reconnectTimeout) return;
    reconnectTimeout = setTimeout(() => {
        console.log("🔄 Reiniciando cliente WhatsApp...");
        try {
            zap.initialize();
        } catch (e) {
            console.error("Erro ao reiniciar WhatsApp:", e);
            scheduleRestart();
        }
    }, 10000);
}

zap.initialize();

// ======== ENVIO WHATSAPP ========
async function enviarWhatsApp(msg, rulesRow) {
    const enabled = Number(rulesRow?.notify_whatsapp ?? (config.whatsapp?.enabled ? 1 : 0)) === 1;
    const grupo = (rulesRow?.whatsapp_group || config.whatsapp?.grupo || "").trim();
    
    if (!enabled) { console.log("⚠️ WhatsApp disabled"); return; }
    if (!grupo) { console.log("⚠️ Grupo não configurado"); return; }
    if (!zapPronto) { console.log("⚠️ WhatsApp não pronto"); return; }
    
    try {
        await zap.sendMessage(grupo, msg);
        console.log("✅ WhatsApp enviado");
    } catch (e) {
        console.error("❌ Erro ao enviar WhatsApp:", e?.message || e);
        const emsg = String(e?.message || "");
        if (emsg.includes("detached Frame") || emsg.includes("closed")) {
            zapPronto = false;
            console.log("⚠️ Frame detach - reconexão agendada");
            scheduleRestart();
        }
    }
}

// ================= BANCO DE DADOS =================
const dbPath = path.join(__dirname, "monitor.db");
const db = new sqlite3.Database(dbPath);

// Configurações de performance do SQLite
db.run("PRAGMA journal_mode = WAL;", (err) => {
    if (err) console.error("❌ Erro WAL:", err);
    else console.log("✅ SQLite em modo WAL");
});
db.run("PRAGMA busy_timeout = 5000;"); // Aguarda até 5s se o banco estiver ocupado
db.run("PRAGMA synchronous = NORMAL;"); // Balance performance/segurança
db.run("PRAGMA cache_size = -64000;"); // ~64MB cache em memória

db.serialize(() => {
    // Tabela principal de APIs/Serviços
    db.run(`CREATE TABLE IF NOT EXISTS apis(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT NOT NULL,
        url TEXT NOT NULL,
        metodo TEXT DEFAULT 'GET',
        headers_json TEXT,
        xml TEXT,
        porta INTEGER,
        ativo INTEGER DEFAULT 1,
        timeout_ms INTEGER DEFAULT 5000,
        mute_until DATETIME,
        tipo TEXT DEFAULT 'Outros',
        interval_ms INTEGER,
        last_check_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        adaptive_enabled INTEGER DEFAULT 1,
        current_interval_ms INTEGER,
        ok_streak INTEGER DEFAULT 0,
        fail_streak INTEGER DEFAULT 0
    )`);

    // Adiciona colunas se não existirem (migração segura)
    const addCol = (t, c, d) => db.run(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`, (e) => {
        if (e && !e.message.includes("duplicate")) console.error(e);
    });
    ["porta","mute_until","type_id","interval_ms","last_check_at","adaptive_enabled","current_interval_ms","ok_streak","fail_streak","tipo","timeout_ms"].forEach(col => addCol("apis", col, "TEXT"));

    // Tipos de monitoramento
    db.run(`CREATE TABLE IF NOT EXISTS monitor_types(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        default_interval_ms INTEGER DEFAULT 3000,
        default_timeout_ms INTEGER DEFAULT 5000,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`INSERT OR IGNORE INTO monitor_types(name,default_interval_ms,default_timeout_ms) VALUES
        ('SERVIDOR',3000,5000),('FIREWALL',5000,4000),('SWITCH',10000,3000),('LINK',15000,3000)`);

    // Logs de verificações
    db.run(`CREATE TABLE IF NOT EXISTS logs(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        tempo INTEGER NOT NULL,
        detalhe TEXT,
        data DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(api_id) REFERENCES apis(id)
    )`);

    // Estado atual de cada API
    db.run(`CREATE TABLE IF NOT EXISTS api_state(
        api_id INTEGER PRIMARY KEY,
        ultimo_status TEXT DEFAULT 'UNKNOWN',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(api_id) REFERENCES apis(id)
    )`);

    // Regras de alerta (threshold, flapping, etc)
    db.run(`CREATE TABLE IF NOT EXISTS alert_rules(
        id INTEGER PRIMARY KEY CHECK(id=1),
        offline_after_sec INTEGER DEFAULT 15,
        slow_ms INTEGER DEFAULT 1200,
        slow_after_sec INTEGER DEFAULT 180,
        flap_window_sec INTEGER DEFAULT 1800,
        flap_count INTEGER DEFAULT 4,
        notify_whatsapp INTEGER DEFAULT 1,
        whatsapp_group TEXT DEFAULT '',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`INSERT OR IGNORE INTO alert_rules(id,offline_after_sec,whatsapp_group,notify_whatsapp) VALUES(1,15,?,?)`,
        [config.whatsapp?.grupo||"", config.whatsapp?.enabled?1:0]);

    // Incidentes (para cálculo de MTTR, histórico)
    db.run(`CREATE TABLE IF NOT EXISTS incidents(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        opened_at DATETIME NOT NULL,
        closed_at DATETIME,
        duration_sec INTEGER DEFAULT 0,
        start_detail TEXT,
        end_detail TEXT,
        start_tempo INTEGER,
        end_tempo INTEGER,
        alerted INTEGER DEFAULT 0,
        alert_at DATETIME,
        FOREIGN KEY(api_id) REFERENCES apis(id)
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_incidents_api_time ON incidents(api_id, opened_at)`);

    // Supressões temporárias (anti-flapping)
    db.run(`CREATE TABLE IF NOT EXISTS suppressions(
        api_id INTEGER PRIMARY KEY,
        until DATETIME NOT NULL,
        reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// ============ DB HELPERS ============
const dbAll = (sql, p=[]) => new Promise((res,rej)=>db.all(sql,p,(e,r)=>e?rej(e):res(r||[])));
const dbGet = (sql, p=[]) => new Promise((res,rej)=>db.get(sql,p,(e,r)=>e?rej(e):res(r)));
const dbRun = (sql, p=[]) => new Promise((res,rej)=>db.run(sql,p,function(e){if(e)return rej(e);res({changes:this.changes,lastID:this.lastID})}));

const setUltimoStatus = (id,st) => dbRun(`INSERT INTO api_state(api_id,ultimo_status,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(api_id) DO UPDATE SET ultimo_status=excluded.ultimo_status,updated_at=CURRENT_TIMESTAMP`,[id,st]);
const nowSqlite = () => new Date().toISOString().replace("T"," ").slice(0,19);

const getRules = async () => {
    const r = await dbGet(`SELECT * FROM alert_rules WHERE id=1`);
    return r || {offline_after_sec:15,slow_ms:1200,slow_after_sec:180,flap_window_sec:1800,flap_count:4,notify_whatsapp:config.whatsapp?.enabled?1:0,whatsapp_group:config.whatsapp?.grupo||""};
};

const getOpenIncident = (api_id,type) => dbGet(`SELECT * FROM incidents WHERE api_id=? AND type=? AND closed_at IS NULL ORDER BY id DESC LIMIT 1`,[api_id,type]);

const openIncident = async ({api_id,type,start_detail,start_tempo}) => {
    const r = await dbRun(`INSERT INTO incidents(api_id,type,opened_at,start_detail,start_tempo,alerted) VALUES(?,?,?,?,?,0)`,[api_id,type,nowSqlite(),start_detail||"",start_tempo??null]);
    console.log(`🆕 Incidente aberto: id=${r.lastID}`); return r.lastID;
};

const closeIncident = async ({id,end_detail,end_tempo}) => {
    const closed = nowSqlite();
    await dbRun(`UPDATE incidents SET closed_at=?,end_detail=?,end_tempo=?,duration_sec=CAST((julianday(?) - julianday(opened_at)) * 86400 AS INTEGER) WHERE id=?`,[closed,end_detail||"",end_tempo??null,closed,id]);
    console.log(`✅ Incidente fechado: id=${id}`);
};

const markIncidentAlerted = (id) => dbRun(`UPDATE incidents SET alerted=1,alert_at=? WHERE id=?`,[nowSqlite(),id]);

const isMuted = async (api_id) => {
    const r = await dbGet(`SELECT mute_until FROM apis WHERE id=?`,[api_id]);
    return r?.mute_until && Date.now() < new Date(r.mute_until.replace(" ","T")+"Z").getTime();
};

const isSuppressed = async (api_id) => {
    const r = await dbGet(`SELECT until FROM suppressions WHERE api_id=?`,[api_id]);
    return r?.until && Date.now() < new Date(r.until.replace(" ","T")+"Z").getTime();
};

const setSuppressed = (api_id,sec,reason) => {
    const until = new Date(Date.now()+sec*1000).toISOString().replace("T"," ").slice(0,19);
    return dbRun(`INSERT INTO suppressions(api_id,until,reason) VALUES(?,?,?) ON CONFLICT(api_id) DO UPDATE SET until=excluded.until,reason=excluded.reason`,[api_id,until,reason||""]);
};

const countFlaps = (api_id,win) => dbGet(`SELECT COUNT(*) AS c FROM incidents WHERE api_id=? AND type='OFFLINE' AND opened_at >= datetime('now',?)`,[api_id,`-${Math.max(60,win||1800)} seconds`]).then(r=>Number(r?.c||0));

const shouldCheck = (api) => {
    const int = Number(api.interval_ms??api.default_interval_ms??3000);
    if(!api.last_check_at) return true;
    return Date.now() - new Date(String(api.last_check_at).replace(" ","T")+"Z").getTime() >= int;
};

const markChecked = (id) => dbRun(`UPDATE apis SET last_check_at=CURRENT_TIMESTAMP WHERE id=?`,[id]);

const updateAdaptiveInterval = async (api,status) => {
    const base = Number(api.interval_ms??api.default_interval_ms??3000)||3000;
    const minF = Math.max(1000,Math.floor(base*0.25)), maxSt = Math.max(base,Math.min(base*10,600000)), maxFail = Math.max(minF,Math.min(base*2,120000));
    if(Number(api.adaptive_enabled??1)!==1) return dbRun(`UPDATE apis SET current_interval_ms=NULL,ok_streak=0,fail_streak=0 WHERE id=?`,[api.id]);
    let ok=Number(api.ok_streak||0), fail=Number(api.fail_streak||0), cur=Number(api.current_interval_ms??base);
    if(status==="ONLINE"){ok++;fail=0;if(cur<base)cur=base;if(ok>=3&&ok%3===0)cur=Math.min(maxSt,Math.round(cur*1.6));}
    else if(status==="OFFLINE"){fail++;ok=0;cur=minF;const steps=Math.max(0,Math.floor((fail-1)/5)); cur=Math.min(maxFail,Math.round(minF*Math.pow(2,Math.min(6,steps))));}
    await dbRun(`UPDATE apis SET current_interval_ms=?,ok_streak=?,fail_streak=? WHERE id=?`,[cur,ok,fail,api.id]);
};

// ================= UTIL =================
const agora = () => {const d=new Date();return{data:d.toLocaleDateString("pt-BR"),hora:d.toLocaleTimeString("pt-BR")};};

const msgCaiuCritico = (n,det) => {const t=agora();return `🚨 *ALERTA CRÍTICO!*\n🔴 Serviço: *${n}*\n📅 ${t.data} 🕒 ${t.hora}\n⚠️ Parou de responder.${det?`\n⚠️ ${det}`:""}`;};
const msgVoltouCritico = (n) => {const t=agora();return `✅ *SERVIÇO RESTABELECIDO!*\n🟢 Serviço: *${n}*\n📅 ${t.data} 🕒 ${t.hora}\n🚀 Voltou a responder.`;};
const msgAindaOffline = (n,min) => {const t=agora();return `⏳ *AINDA OFFLINE*\n🔴 Serviço: *${n}*\n📅 ${t.data} 🕒 ${t.hora}\n⚠️ Indisponível há ~${min} min.`;};
const msgFlap = (n,cnt,win) => {const t=agora(),min=Math.round((win||1800)/60);return `⚠️ *INSTABILIDADE*\n🟡 Serviço: *${n}*\n📅 ${t.data} 🕒 ${t.hora}\n🔁 ${cnt} quedas em ~${min} min.\n➡️ Alertas suprimidos temporariamente.`;};
const limparTexto = (s) => s==null?"":String(s).replace(/\s+/g," ").trim();

// ================= MONITOR =================
const httpsAgent = new https.Agent({rejectUnauthorized:false,keepAlive:true});
let rodando=false; const lastStillDownAt=new Map();

const parseHeaders = (h) => {let o={};try{if(h?.trim())o=JSON.parse(h);}catch{ return {headers:{},err:"inválido"};} return {headers:o,err:""};};

const checarPing = async (host,ms) => {const ini=Date.now();try{const r=await ping.promise.probe(host,{timeout:Math.max(1,Math.ceil(ms/1000)),extra:["-n","1"]});return{status:r.alive?"ONLINE":"OFFLINE",tempo:Date.now()-ini,detalhe:r.alive?"":"Sem resposta"};}catch(e){return{status:"OFFLINE",tempo:Date.now()-ini,detalhe:e.message||"PING falhou"};}};

const checarTcp = (host,port,ms) => new Promise((res)=>{const ini=Date.now(),sock=new net.Socket(),done=(st,dt)=>{if(sock.destroyed)return;sock.destroy();res({status:st,tempo:Date.now()-ini,detalhe:dt||""});};sock.setTimeout(ms);sock.once("connect",()=>done("ONLINE",""));sock.once("timeout",()=>done("OFFLINE","Timeout TCP"));sock.once("error",(e)=>done("OFFLINE",e?.message||"Erro TCP"));sock.connect(Number(port),host);});

const checarHttp = async (api,ms) => {let st="OFFLINE",tp=0,dt="";const ini=Date.now(),to=Number(ms)||5000,met=String(api.metodo||"GET").toUpperCase(),{headers,err}=parseHeaders(api.headers_json);if(err)dt=err;const body=api.xml?.trim()?api.xml:"";try{const r=met==="GET"?await axios.get(api.url,{headers,timeout:to,validateStatus:null,httpsAgent}):await axios.post(api.url,body,{headers,timeout:to,validateStatus:null,httpsAgent});tp=Date.now()-ini;st="ONLINE";const raw=typeof r.data==="string"?r.data:JSON.stringify(r.data);if(!dt&&raw&&raw.length<120)dt=raw.trim();}catch(e){tp=Date.now()-ini;dt=e.message||"Erro";}return{status:st,tempo:tp,detalhe:dt};};

const verificarApi = async (api) => {
    const met=String(api.metodo||"GET").toUpperCase(),to=Number(api.timeout_ms??api.default_timeout_ms??5000)||5000;
    let res;
    if(met==="PING")res=await checarPing(String(api.url||"").replace(/^https?:\/\//i,"").split("/")[0],to);
    else if(met==="TCP"||met==="TELNET")res=await checarTcp(String(api.url||"").replace(/^https?:\/\//i,"").split("/")[0],Number(api.porta)||80,to);
    else res=await checarHttp(api,to);

    await dbRun("INSERT INTO logs(api_id,status,tempo,detalhe) VALUES(?,?,?,?)",[api.id,res.status,res.tempo,res.detalhe]);
    const rules=await getRules(),muted=await isMuted(api.id),supp=await isSuppressed(api.id),off=await getOpenIncident(api.id,"OFFLINE");

    if(res.status==="OFFLINE"){
        if(!off){console.log(`🔴 [OFFLINE] ${api.nome}`);await openIncident({api_id:api.id,type:"OFFLINE",start_detail:res.detalhe,start_tempo:res.tempo});}
        else if(!Number(off.alerted)){
            const sec=Number((await dbGet(`SELECT CAST((julianday(CURRENT_TIMESTAMP)-julianday(?))*86400 AS INTEGER) AS sec`,[off.opened_at]))?.sec||0),thr=Math.max(3,Number(rules.offline_after_sec||15));
            if(!muted&&!supp&&sec>=thr){
                console.log(`🚨 Threshold atingido: ${api.nome}`);
                const flaps=await countFlaps(api.id,rules.flap_window_sec||1800),flapC=Math.max(2,Number(rules.flap_count||4));
                if(flaps>=flapC){await enviarWhatsApp(msgFlap(api.nome,flaps,rules.flap_window_sec||1800),rules);await setSuppressed(api.id,20*60,"flapping");}
                else{await enviarWhatsApp(msgCaiuCritico(api.nome,res.detalhe),rules);await markIncidentAlerted(off.id);}
            }
        }else{
            const sec2=Number((await dbGet(`SELECT CAST((julianday(CURRENT_TIMESTAMP)-julianday(?))*86400 AS INTEGER) AS sec`,[off.opened_at]))?.sec||0);
            if(sec2>=300){const last=lastStillDownAt.get(api.id)||0;if(Date.now()-last>=600000&&!muted&&!(await isSuppressed(api.id))){await enviarWhatsApp(msgAindaOffline(api.nome,Math.round(sec2/60)),rules);lastStillDownAt.set(api.id,Date.now());}}
        }
    }
    if(res.status==="ONLINE"&&off){
        console.log(`🟢 [ONLINE] ${api.nome}`);const alertou=Number(off.alerted)===1;await closeIncident({id:off.id,end_detail:res.detalhe,end_tempo:res.tempo});
        if(alertou&&!muted)await enviarWhatsApp(msgVoltouCritico(api.nome),rules);
        lastStillDownAt.delete(api.id);
    }
    await updateAdaptiveInterval(api,res.status);await setUltimoStatus(api.id,res.status);
    console.log(`📊 ${api.nome}|${res.status}|${res.tempo}ms`);
};

const loopMonitor = async () => {
    if(rodando)return;rodando=true;
    try{
        const apis=await dbAll(`SELECT a.*,t.name AS type_name,t.default_interval_ms,t.default_timeout_ms FROM apis a LEFT JOIN monitor_types t ON t.id=a.type_id WHERE a.ativo=1 ORDER BY a.id`);
        const toCheck=apis.filter(shouldCheck),queue=[...toCheck],CONC=8;
        const worker = async (q) => {while(q.length){const api=q.shift();try{await verificarApi(api);await markChecked(api.id);}catch(e){console.log(`❌ Erro ${api?.nome}:`,e.message);}}};
        await Promise.all(Array.from({length:Math.min(CONC,queue.length)},()=>worker(queue)));
        if(toCheck.length)console.log(`🔄 Loop: ${apis.length} ativos | ${toCheck.length} checados`);
    }catch(e){console.error("❌ Erro loopMonitor:",e.message);}finally{rodando=false;}
};
setInterval(()=>loopMonitor().catch(e=>console.error("Erro loop:",e)),1000);
loopMonitor().catch(()=>{});

// ================= WHATSAPP COMMANDS =================
let lastVerificarAt=0;
zap.on("message",async(msg)=>{
    try{if(msg.fromMe||!config.whatsapp?.enabled)return;const grp=config.whatsapp?.grupo;if(!grp||msg.from!==grp)return;const txt=(msg.body||"").trim().toUpperCase();
        if(txt==="VERIFICAR"||txt==="STATUS"){if(Date.now()-lastVerificarAt<10000)return;lastVerificarAt=Date.now();if(!zapPronto){await zap.sendMessage(grp,"⚠️ Conectando...");return;}const res=await dbAll(`SELECT a.*,t.name AS type_name FROM apis a LEFT JOIN monitor_types t ON t.id=a.type_id ORDER BY a.id`);let on=0,off=0,lin=[];for(const a of res){const l=await dbGet("SELECT status,tempo,detalhe,data FROM logs WHERE api_id=? ORDER BY id DESC LIMIT 1",[a.id]);const r={nome:a.nome||"?",last_status:l?.status||"—",last_tempo:l?.tempo??null,last_detalhe:l?.detalhe||"",type_name:a.type_name};if(r.last_status==="ONLINE")on++;if(r.last_status==="OFFLINE")off++;lin.push(r);}await zap.sendMessage(grp,`📡 *STATUS*\n🗓️ ${agora().data} ${agora().hora}\n📌 Total:${res.length}|✅${on}|❌${off}\n${lin.map(r=>`• ${r.nome}(${r.type_name||"?"})|${r.last_status}|${r.last_tempo??"-"}ms`).join("\n")}`);}
        if(txt.startsWith("SILENCIAR")){const p=txt.split(/\s+/),id=Number(p[1]),dur=(p[2]||"30M").toUpperCase();if(!id){await zap.sendMessage(grp,"Uso: SILENCIAR <id> <30M|2H>");return;}let min=30,m=dur.match(/^(\d+)(M|H)$/);if(m)min=m[2]==="H"?Number(m[1])*60:Number(m[1]);await dbRun(`UPDATE apis SET mute_until=? WHERE id=?`,[new Date(Date.now()+min*60*1000).toISOString().replace("T"," ").slice(0,19),id]);await zap.sendMessage(grp,`🔕 Silenciado por ${min}min`);}
        if(txt.startsWith("ATIVAR")){const p=txt.split(/\s+/),id=Number(p[1]);if(!id){await zap.sendMessage(grp,"Uso: ATIVAR <id>");return;}await dbRun(`UPDATE apis SET mute_until=NULL WHERE id=?`,[id]);await zap.sendMessage(grp,`🔔 Reativado`);}
    }catch(e){console.log("❌ Erro cmd WhatsApp:",e.message);}
});

// ================= API ROUTES =================
app.post("/login",(req,res)=>{if(req.body.user===config.login?.user&&req.body.pass===config.login?.pass){req.session.logado=true;return res.json({ok:true});}res.json({ok:false});});
app.post("/logout",(req,res)=>{req.session.destroy(()=>res.json({ok:true}));});

app.get("/api/types",auth,async(req,res)=>{try{res.json(await dbAll("SELECT*FROM monitor_types ORDER BY name"));}catch(e){res.status(500).json({error:e.message});}});
app.post("/api/types",auth,async(req,res)=>{try{const n=String(req.body?.name||"").trim().toUpperCase(),int=Math.max(500,Number(req.body?.default_interval_ms??3000)),to=Math.max(500,Number(req.body?.default_timeout_ms??5000));if(!n)return res.status(400).json({error:"name obrigatório"});const r=await dbRun(`INSERT INTO monitor_types(name,default_interval_ms,default_timeout_ms) VALUES(?,?,?)`,[n,int,to]);res.json({ok:true,id:r.lastID});}catch(e){res.status(500).json({error:e.message});}});
app.put("/api/types/:id",auth,async(req,res)=>{try{const id=Number(req.params.id),n=String(req.body?.name||"").trim().toUpperCase(),int=Math.max(500,Number(req.body?.default_interval_ms??3000)),to=Math.max(500,Number(req.body?.default_timeout_ms??5000));if(!id||!n)return res.status(400).json({error:"inválido"});const r=await dbRun(`UPDATE monitor_types SET name=?,default_interval_ms=?,default_timeout_ms=? WHERE id=?`,[n,int,to,id]);res.json({ok:true,changes:r.changes});}catch(e){res.status(500).json({error:e.message});}});

app.get("/api/alert-rules",auth,async(req,res)=>{try{const r=await getRules();res.json({offline_after_sec:Number(r.offline_after_sec??15),slow_ms:Number(r.slow_ms??1200),slow_after_sec:Number(r.slow_after_sec??180),flap_window_sec:Number(r.flap_window_sec??1800),flap_count:Number(r.flap_count??4),notify_whatsapp:Number(r.notify_whatsapp??1),whatsapp_group:String(r.whatsapp_group??""),zapPronto});}catch(e){res.status(500).json({error:e.message,zapPronto});}});

// 🔧 LINHA CORRIGIDA ABAIXO 👇
app.put("/api/alert-rules",auth,async(req,res)=>{try{const b=req.body||{};await dbRun(`UPDATE alert_rules SET offline_after_sec=?,slow_ms=?,slow_after_sec=?,flap_window_sec=?,flap_count=?,notify_whatsapp=?,whatsapp_group=?,updated_at=CURRENT_TIMESTAMP WHERE id=1`,[Math.max(3,Number(b.offline_after_sec??15)),Math.max(50,Number(b.slow_ms??1200)),Math.max(10,Number(b.slow_after_sec??180)),Math.max(60,Number(b.flap_window_sec??1800)),Math.max(2,Number(b.flap_count??4)),Number(b.notify_whatsapp??1)?1:0,String(b.whatsapp_group ?? "").trim()]);res.json({ok:true,rules:await getRules()});}catch(e){res.status(500).json({ok:false,error:e.message});}});

app.post("/api/test-whatsapp",auth,async(req,res)=>{try{const r=await getRules();await enviarWhatsApp((req.body?.msg||"").trim()||"🚀 TESTE OK",r);res.json({ok:true,zapPronto});}catch(e){res.json({ok:false,error:e.message,zapPronto});}});

app.get("/api/apis",auth,async(req,res)=>{try{res.json(await dbAll(`SELECT a.*,t.name AS type_name,t.default_interval_ms,t.default_timeout_ms FROM apis a LEFT JOIN monitor_types t ON t.id=a.type_id ORDER BY a.id DESC`));}catch(e){res.status(500).json({error:e.message});}});
app.post("/api/apis",auth,async(req,res)=>{try{const{nome,url,metodo="GET",headers_json="",xml="",porta=null,ativo=1,timeout_ms=null,type_id=null,interval_ms=null,adaptive_enabled=1,tipo="",mute_until=null}=req.body||{};if(!nome||!url)return res.status(400).json({error:"nome e url obrigatórios"});const r=await dbRun(`INSERT INTO apis(nome,url,metodo,headers_json,xml,porta,ativo,timeout_ms,type_id,interval_ms,adaptive_enabled,current_interval_ms,ok_streak,fail_streak,tipo) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[nome.trim(),url.trim(),String(metodo).toUpperCase(),headers_json||"",xml||"",porta!=null?Number(porta):null,Number(ativo)?1:0,timeout_ms!=null?Number(timeout_ms):null,type_id!=null?Number(type_id):null,interval_ms!=null?Number(interval_ms):null,Number(adaptive_enabled)?1:0,null,0,0,String(tipo||"Outros").trim()]);await setUltimoStatus(r.lastID,"UNKNOWN");res.json({ok:true,id:r.lastID});}catch(e){res.status(500).json({error:e.message});}});
app.put("/api/apis/:id",auth,async(req,res)=>{try{const id=Number(req.params.id),{nome,url,metodo="GET",headers_json="",xml="",porta=null,ativo=1,timeout_ms=null,type_id=null,interval_ms=null,adaptive_enabled=1,mute_until=null,tipo="Outros"}=req.body||{};if(!nome||!url)return res.status(400).json({error:"nome e url obrigatórios"});const r=await dbRun(`UPDATE apis SET nome=?,url=?,metodo=?,headers_json=?,xml=?,porta=?,ativo=?,timeout_ms=?,type_id=?,interval_ms=?,adaptive_enabled=?,current_interval_ms=?,ok_streak=?,fail_streak=?,mute_until=?,tipo=? WHERE id=?`,[nome.trim(),url.trim(),String(metodo).toUpperCase(),headers_json||"",xml||"",porta!=null?Number(porta):null,Number(ativo)?1:0,timeout_ms!=null?Number(timeout_ms):null,type_id!=null?Number(type_id):null,interval_ms!=null?Number(interval_ms):null,Number(adaptive_enabled)?1:0,interval_ms!=null?Number(interval_ms):null,0,0,mute_until?String(mute_until):null,String(tipo||"Outros").trim(),id]);res.json({ok:true,changes:r.changes});}catch(e){res.status(500).json({error:e.message});}});
app.delete("/api/apis/:id",auth,async(req,res)=>{try{const id=Number(req.params.id);await dbRun("DELETE FROM apis WHERE id=?",[id]);await dbRun("DELETE FROM api_state WHERE api_id=?",[id]);res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});

app.get("/api/logs",auth,async(req,res)=>{try{const api_id=req.query.api_id?Number(req.query.api_id):null,limit=req.query.limit?Math.min(Number(req.query.limit),2000):500;if(!api_id)return res.status(400).json({error:"api_id obrigatório"});res.json(await dbAll("SELECT*FROM logs WHERE api_id=? ORDER BY id DESC LIMIT ?",[api_id,limit]));}catch(e){res.status(500).json({error:e.message});}});

app.get("/api/summary",auth,async(req,res)=>{try{const apis=await dbAll(`SELECT a.*,t.name AS type_name,t.default_interval_ms,t.default_timeout_ms FROM apis a LEFT JOIN monitor_types t ON t.id=a.type_id ORDER BY a.id DESC`),result=[];for(const a of apis){const l=await dbGet("SELECT status,tempo,detalhe,data FROM logs WHERE api_id=? ORDER BY id DESC LIMIT 1",[a.id]);result.push({id:a.id,nome:a.nome,type_id:a.type_id,type_name:a.type_name||null,url:a.url,metodo:a.metodo,porta:a.porta,ativo:a.ativo,timeout_ms:a.timeout_ms,interval_ms:a.interval_ms,adaptive_enabled:a.adaptive_enabled??1,current_interval_ms:a.current_interval_ms??null,ok_streak:a.ok_streak??0,fail_streak:a.fail_streak??0,effective_interval_ms:Number(Number(a.adaptive_enabled??1)===1?a.current_interval_ms??a.interval_ms??a.default_interval_ms??3000:a.interval_ms??a.default_interval_ms??3000),mute_until:a.mute_until,tipo:a.tipo||a.type_name||null,last_check_at:a.last_check_at,last_status:l?.status||"—",last_tempo:l?.tempo??null,last_detalhe:l?.detalhe||"",last_data:l?.data||null});}res.json(result);}catch(e){res.status(500).json({error:e.message});}});

// ================= RELATÓRIOS =================
app.get("/api/reports/overview",auth,async(req,res)=>{try{const{from,to,type="",api_id=""}=req.query;if(!from||!to)return res.status(400).json({error:"from/to obrigatórios"});const where=[],params=[];where.push(`opened_at BETWEEN ? AND ?`);params.push(`${from} 00:00:00`,`${to} 23:59:59`);if(type){where.push(`type=?`);params.push(type);}if(api_id){where.push(`api_id=?`);params.push(Number(api_id));}const whereSql=`WHERE ${where.join(" AND ")}`;const row=await dbGet(`SELECT COUNT(*) AS total_incidents,COALESCE(SUM(CASE WHEN type='OFFLINE' THEN duration_sec ELSE 0 END),0) AS total_downtime_sec,COALESCE(AVG(CASE WHEN type='OFFLINE' THEN duration_sec END),0) AS mttr_sec FROM incidents ${whereSql}`,params);const topDown=await dbAll(`SELECT api_id,COALESCE(SUM(CASE WHEN type='OFFLINE' THEN duration_sec ELSE 0 END),0) AS downtime_sec FROM incidents ${whereSql} GROUP BY api_id ORDER BY downtime_sec DESC LIMIT 10`,params);const topInc=await dbAll(`SELECT api_id,COUNT(*) AS incidents FROM incidents ${whereSql} GROUP BY api_id ORDER BY incidents DESC LIMIT 10`,params);const ids=Array.from(new Set([...topDown.map(x=>x.api_id),...topInc.map(x=>x.api_id)]));let nameMap=new Map();if(ids.length){const names=await dbAll(`SELECT id,nome FROM apis WHERE id IN (${ids.map(()=>"?").join(",")})`,ids);nameMap=new Map(names.map(n=>[Number(n.id),n.nome]));}const top_by_downtime=topDown.map(x=>({...x,service_name:nameMap.get(Number(x.api_id))||null}));const top_by_incidents=topInc.map(x=>({...x,service_name:nameMap.get(Number(x.api_id))||null}));res.json({total_incidents:Number(row?.total_incidents||0),total_downtime_sec:Number(row?.total_downtime_sec||0),mttr_sec:Math.round(Number(row?.mttr_sec||0)),worst_service_name:top_by_downtime[0]?.service_name||null,top_by_downtime,top_by_incidents});}catch(e){res.status(500).json({error:e.message});}});

app.get("/api/reports/incidents",auth,async(req,res)=>{try{const{from,to,type="",api_id=""}=req.query;if(!from||!to)return res.status(400).json({error:"from/to obrigatórios"});const where=[],params=[];where.push(`i.opened_at BETWEEN ? AND ?`);params.push(`${from} 00:00:00`,`${to} 23:59:59`);if(type){where.push(`i.type=?`);params.push(type);}if(api_id){where.push(`i.api_id=?`);params.push(Number(api_id));}const whereSql=`WHERE ${where.join(" AND ")}`;const rows=await dbAll(`SELECT i.*,a.nome AS service_name,a.url AS service_url,a.metodo AS service_method FROM incidents i LEFT JOIN apis a ON a.id=i.api_id ${whereSql} ORDER BY i.opened_at DESC LIMIT 5000`,params);res.json(rows||[]);}catch(e){res.status(500).json({error:e.message});}});

app.get("/api/reports/timeline",auth,async(req,res)=>{try{const{from,to,api_id=""}=req.query;if(!from||!to)return res.status(400).json({error:"from/to obrigatórios"});const where=[`opened_at BETWEEN ? AND ?`],params=[`${from} 00:00:00`,`${to} 23:59:59`];if(api_id){where.push(`api_id=?`);params.push(Number(api_id));}const whereSql=`WHERE ${where.join(" AND ")}`;const rows=await dbAll(`SELECT substr(opened_at,1,10) AS day,COUNT(*) AS incidents,COALESCE(SUM(CASE WHEN type='OFFLINE' THEN duration_sec ELSE 0 END),0) AS downtime_sec FROM incidents ${whereSql} GROUP BY day ORDER BY day ASC`,params);res.json(rows||[]);}catch(e){res.status(500).json({error:e.message});}});

// ================= EXPORT CSV =================
app.get("/api/reports/export.csv",auth,async(req,res)=>{try{const{from,to}=req.query;if(!from||!to)return res.status(400).send("from/to obrigatórios");const rows=await dbAll(`SELECT i.id,a.nome AS service_name,i.type,i.opened_at,i.closed_at,i.duration_sec,i.start_detail,i.end_detail FROM incidents i LEFT JOIN apis a ON a.id=i.api_id WHERE i.opened_at BETWEEN ? AND ? ORDER BY i.opened_at DESC`,[`${from} 00:00:00`,`${to} 23:59:59`]);let csv="ID;Serviço;Tipo;Aberto em;Fechado em;Duração (s);Detalhe Início;Detalhe Fim\n";for(const r of rows){csv+=[r.id,(r.service_name||"").replace(/;/g,","),r.type||"",r.opened_at||"",r.closed_at||"",r.duration_sec||0,(r.start_detail||"").replace(/;/g,","),(r.end_detail||"").replace(/;/g,",")].join(";")+"\n";}res.setHeader("Content-Type","text/csv; charset=utf-8");res.setHeader("Content-Disposition","attachment; filename=relatorio_monitor.csv");res.send(csv);}catch(e){res.status(500).send(e.message);}});

// ================= EXPORT XLSX =================
app.get("/api/reports/export.xlsx",auth,async(req,res)=>{try{if(!ExcelJS){return res.status(500).send("exceljs não instalado. Rode: npm i exceljs");}const{from,to}=req.query;if(!from||!to)return res.status(400).send("from/to obrigatórios");const incidents=await dbAll(`SELECT i.id,i.type,i.opened_at,i.closed_at,i.duration_sec,i.start_detail,i.end_detail,a.nome AS service_name,a.url AS service_url,a.metodo AS service_method FROM incidents i LEFT JOIN apis a ON a.id=i.api_id WHERE i.opened_at BETWEEN ? AND ? ORDER BY i.opened_at DESC`,[`${from} 00:00:00`,`${to} 23:59:59`]);const wb=new ExcelJS.Workbook();const ws=wb.addWorksheet("Incidentes");ws.columns=[{header:"ID",key:"id",width:8},{header:"Serviço",key:"service_name",width:28},{header:"Tipo",key:"type",width:12},{header:"Aberto em",key:"opened_at",width:20},{header:"Fechado em",key:"closed_at",width:20},{header:"Duração (s)",key:"duration_sec",width:12},{header:"Método",key:"service_method",width:10},{header:"URL",key:"service_url",width:45},{header:"Detalhe início",key:"start_detail",width:50},{header:"Detalhe fim",key:"end_detail",width:50}];incidents.forEach(r=>ws.addRow(r));ws.getRow(1).font={bold:true};res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");res.setHeader("Content-Disposition","attachment; filename=relatorio_monitor.xlsx");await wb.xlsx.write(res);res.end();}catch(e){res.status(500).send(e.message);}});

// ================= START SERVER =================
const PORT = config.port || 3011;
const HOST = process.env.HOST || "0.0.0.0";

app.listen(PORT, HOST, () => {
    console.log("==================================");
    console.log(" NOC MONITOR - BLINDADO ✅");
    console.log(` 🌐 http://${HOST==='0.0.0.0'?'localhost':HOST}:${PORT}/login.html`);
    console.log(` 📁 DB: ${dbPath}`);
    console.log("==================================");
    if(process.env.PM2_USAGE) console.log("[PM2] App ready");
});

// ================= GRACEFUL SHUTDOWN =================
process.on('SIGINT', () => {
    console.log("\n🔄 Recebido SIGINT - Fechando banco...");
    db.close((err) => {
        if (err) console.error("❌ Erro ao fechar DB:", err);
        else console.log("✅ Banco fechado");
        process.exit(0);
    });
});