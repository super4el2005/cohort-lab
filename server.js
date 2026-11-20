import {createServer} from 'node:http';
import {randomBytes, scryptSync, timingSafeEqual, createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync, readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {diagnoses, groups, statuses, sexes, mockPatients} from './seed.js';

const path = process.env.DB_PATH || 'data/cohort.sqlite';
mkdirSync(dirname(path), {recursive: true});
const db = new DatabaseSync(path);
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    login TEXT PRIMARY KEY, hash TEXT NOT NULL, role TEXT NOT NULL
      CHECK(role IN ('admin','doctor','researcher'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, login TEXT NOT NULL REFERENCES users(login), expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS patients (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, age INTEGER NOT NULL,
    sex TEXT NOT NULL, diagnosis TEXT NOT NULL, "group" TEXT NOT NULL,
    status TEXT NOT NULL, date TEXT NOT NULL, baseline INTEGER NOT NULL, followup INTEGER
  );
  CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY);
`);

const hashPassword = (password, salt = randomBytes(16).toString('hex')) =>
  salt + ':' + scryptSync(password, salt, 64).toString('hex');
const digest = value => createHash('sha256').update(value).digest('hex');
const fallback = hashPassword(randomBytes(32).toString('hex'));
const fields = ['name','age','sex','diagnosis','group','status','date','baseline','followup'];
const columns = fields.map(field => '"' + field + '"');
const insertPatient = db.prepare('INSERT INTO patients (' + columns.join(',') + ') VALUES (?,?,?,?,?,?,?,?,?)');
const values = patient => fields.map(field => patient[field]);

db.exec('BEGIN IMMEDIATE');
try {
  for (const role of ['admin','doctor','researcher']) {
    if (db.prepare('SELECT login FROM users WHERE login=?').get(role)) continue;
    const password = process.env[role.toUpperCase() + '_PASSWORD'];
    if (!password || password.length < 12 || password.length > 128) {
      throw new Error('Set ' + role.toUpperCase() + '_PASSWORD (12–128 characters)');
    }
    db.prepare('INSERT INTO users VALUES (?,?,?)').run(role, hashPassword(password), role);
  }
  if (db.prepare("INSERT OR IGNORE INTO metadata VALUES ('patients-seeded')").run().changes) {
    for (const patient of mockPatients()) insertPatient.run(...values(patient));
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

const assets = new Map([
  ['/', ['index.html','text/html']],
  ['/app.js', ['app.js','text/javascript']],
  ['/style.css', ['style.css','text/css']]
].map(([url,[file,type]]) => [url,[type,readFileSync(new URL('./public/' + file, import.meta.url))]]));
const ttl = 12 * 60 * 60;
const cookie = 'Path=/; HttpOnly; SameSite=Strict' + (process.env.NODE_ENV === 'production' ? '; Secure' : '');
const fail = (status, message) => Object.assign(new Error(message), {status});
const send = (res, code, data) => {
  res.writeHead(code, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(data));
};
const tokenFrom = req => /(?:^|; *)cohort=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
const session = token => token && db.prepare(
  'SELECT u.login,u.role FROM sessions s JOIN users u ON u.login=s.login WHERE s.token=? AND s.expires>?'
).get(digest(token), Date.now());

async function body(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw fail(415,'Ожидается JSON');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({destroyOnReturn:false})) {
    size += chunk.length;
    if (size > 16384) {
      req.resume();
      throw fail(413,'Запрос слишком большой');
    }
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString());
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw fail(400,'Некорректный запрос');
  }
}

function validatedPatient(p) {
  const name = typeof p.name === 'string' ? p.name.trim() : '';
  const numeric = (value,min,max) => Number.isInteger(value) && value >= min && value <= max;
  const date = typeof p.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? new Date(p.date) : null;
  if (!name || name.length > 100 || !numeric(p.age, 0, 120) ||
      !sexes.includes(p.sex) || !diagnoses.includes(p.diagnosis) || !groups.includes(p.group) ||
      !statuses.includes(p.status) || !date || Number.isNaN(+date) ||
      date.toISOString().slice(0,10) !== p.date || !numeric(p.baseline, 40, 300) ||
      (p.followup !== null && !numeric(p.followup, 40, 300))) {
    throw fail(422,'Проверьте поля карточки пациента');
  }
  return {...p, name};
}

const attempts = new Map();
const windowMs = 10 * 60 * 1000;
const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, record] of attempts) if (record.until <= now) attempts.delete(key);
  db.prepare('DELETE FROM sessions WHERE expires<=?').run(now);
}, 60_000);
cleanup.unref();

function limit(req) {
  const key = process.env.RENDER === 'true'
    ? (req.headers['x-forwarded-for'] || '').split(',').at(-1).trim() || req.socket.remoteAddress
    : req.socket.remoteAddress;
  const now = Date.now();
  let record = attempts.get(key);
  if (!record || record.until <= now) {
    if (attempts.size >= 10000 && !record) throw fail(429,'Попробуйте позже');
    record = {count:0, until:now + windowMs};
    attempts.set(key, record);
  }
  if (record.count >= 20) throw fail(429,'Слишком много попыток. Попробуйте позже');
  record.count++;
  return key;
}

async function authenticate(req, res, register) {
  const key = limit(req);
  const input = await body(req);
  const login = typeof input.login === 'string' ? input.login.trim().toLowerCase() : '';
  const {password} = input;
  if (!/^[a-z0-9_.-]{3,48}$/.test(login) || typeof password !== 'string' ||
      password.length < 12 || password.length > 128) {
    throw fail(400,'Логин: 3–48 латинских букв, цифр или знаков ._- . Пароль: 12–128 символов.');
  }
  let user = db.prepare('SELECT * FROM users WHERE login=?').get(login);
  if (register) {
    if (user) throw fail(409,'Логин уже занят');
    user = {login, role:'researcher', hash:hashPassword(password)};
    db.prepare('INSERT INTO users VALUES (?,?,?)').run(user.login,user.hash,user.role);
  } else {
    const [salt, expected] = (user?.hash || fallback).split(':');
    const actual = scryptSync(password, salt, 64);
    if (!timingSafeEqual(actual, Buffer.from(expected,'hex')) || !user) throw fail(401,'Неверный логин или пароль');
    attempts.delete(key);
  }
  const previous = tokenFrom(req);
  if (previous) db.prepare('DELETE FROM sessions WHERE token=?').run(digest(previous));
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(token),user.login,Date.now() + ttl * 1000);
  res.setHeader('Set-Cookie','cohort=' + token + '; ' + cookie + '; Max-Age=' + ttl);
  send(res,register ? 201 : 200,{login:user.login,role:user.role});
}

async function route(req,res) {
  const {pathname} = new URL(req.url,'http://localhost');
  const method = req.method;
  if (method === 'GET' && assets.has(pathname)) {
    const [type, content] = assets.get(pathname);
    res.writeHead(200,{'Content-Type':type + '; charset=utf-8','Cache-Control':'no-cache'});
    return res.end(content);
  }
  if (method === 'GET' && pathname === '/api/health') {
    db.prepare('SELECT 1').get();
    return send(res,200,{ok:true});
  }
  if (req.headers['sec-fetch-site'] === 'cross-site' && method !== 'GET') throw fail(403,'Запрос отклонён');
  if (method === 'POST' && pathname === '/api/login') return authenticate(req,res,false);
  if (method === 'POST' && pathname === '/api/register') return authenticate(req,res,true);
  const token = tokenFrom(req);
  if (method === 'POST' && pathname === '/api/logout') {
    if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(digest(token));
    res.setHeader('Set-Cookie','cohort=; ' + cookie + '; Max-Age=0');
    return send(res,200,{ok:true});
  }
  if (!pathname.startsWith('/api/')) throw fail(404,'Страница не найдена');
  const user = session(token);
  if (!user) throw fail(401,'Войдите в систему');
  if (method === 'GET' && pathname === '/api/me') return send(res,200,user);
  if (method === 'GET' && pathname === '/api/users') {
    if (user.role !== 'admin') throw fail(403,'Недостаточно прав');
    return send(res,200,db.prepare('SELECT login,role FROM users ORDER BY login').all());
  }
  const casePath = /^\/api\/patients(?:\/([1-9]\d*))?$/.exec(pathname);
  if (!casePath) throw fail(404,'Маршрут не найден');
  const id = casePath[1];
  if (method === 'GET') {
    if (!id) return send(res,200,db.prepare('SELECT * FROM patients ORDER BY id').all());
    const patient = db.prepare('SELECT * FROM patients WHERE id=?').get(id);
    if (!patient) throw fail(404,'Пациент не найден');
    return send(res,200,patient);
  }
  if (user.role === 'researcher') throw fail(403,'У исследователя доступ только на чтение');
  if (method === 'POST' && !id) {
    const patient = validatedPatient(await body(req));
    const {lastInsertRowid} = insertPatient.run(...values(patient));
    return send(res,201,{id:lastInsertRowid});
  }
  if (method === 'PUT' && id) {
    const patient = validatedPatient(await body(req));
    const changes = db.prepare('UPDATE patients SET ' + columns.map(c => c + '=?').join(',') + ' WHERE id=?')
      .run(...values(patient),id).changes;
    if (!changes) throw fail(404,'Пациент не найден');
    return send(res,200,{id:Number(id)});
  }
  if (method === 'DELETE' && id) {
    if (!db.prepare('DELETE FROM patients WHERE id=?').run(id).changes) throw fail(404,'Пациент не найден');
    return send(res,200,{ok:true});
  }
  throw fail(405,'Метод не поддерживается');
}

export async function handleRequest(req,res) {
  res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  try {
    await route(req,res);
  } catch (error) {
    if (!error.status) console.error(error);
    if (!res.headersSent) send(res,error.status || 500,{error:error.status ? error.message : 'Ошибка сервера'});
    else res.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const server = createServer(handleRequest);
  server.listen(Number(process.env.PORT || 3000),'0.0.0.0',() => {
    console.log('Cohort Lab ready :' + server.address().port);
  });
}
