import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';

test('seed, sessions, registration and role permissions', async () => {
  Object.assign(process.env,{
    DB_PATH:':memory:', NODE_ENV:'test',
    ADMIN_PASSWORD:'admin-test-pass', DOCTOR_PASSWORD:'doctor-test-pass',
    RESEARCHER_PASSWORD:'research-test-pass'
  });
  const {handleRequest} = await import('../server.js');
  async function request(path, method = 'GET', body, cookie = '') {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    req.url = '/api/' + path;
    req.headers = {'content-type':'application/json',cookie};
    req.socket = {remoteAddress:'127.0.0.1'};
    const headers = {};
    let code, data;
    const res = {
      setHeader(name,value) { headers[name.toLowerCase()] = value; },
      writeHead(status) { code = status; this.headersSent = true; },
      end(value) { data = JSON.parse(value); }
    };
    await handleRequest(req,res);
    return {code,data,cookie:headers['set-cookie']?.split(';')[0]};
  }
  assert.equal((await request('patients')).code,401);
  assert.equal((await request('login','POST',{login:'admin',password:'incorrect-password'})).code,401);
  const admin = await request('login','POST',{login:'admin',password:'admin-test-pass'});
  const doctor = await request('login','POST',{login:'doctor',password:'doctor-test-pass'});
  const researcher = await request('login','POST',{login:'researcher',password:'research-test-pass'});
  assert.equal(admin.data.role,'admin');
  assert.equal(doctor.data.role,'doctor');
  assert.equal(researcher.data.role,'researcher');
  assert.equal((await request('users','GET',undefined,admin.cookie)).data.length,3);
  assert.equal((await request('users','GET',undefined,doctor.cookie)).code,403);
  const seed = await request('patients','GET',undefined,researcher.cookie);
  assert.equal(seed.data.length,100);
  assert.ok(seed.data.some(patient => patient.followup === null));
  const signup = await request('register','POST',{login:'new-user',password:'created-demo-password',role:'admin'});
  assert.equal(signup.code,201);
  assert.equal(signup.data.role,'researcher');
  assert.equal((await request('register','POST',{login:'admin',password:'created-demo-password'})).code,409);
  const payload = {...seed.data[0],name:'Test card'};
  assert.equal((await request('patients','POST',payload,researcher.cookie)).code,403);
  assert.equal((await request('patients','POST',{...payload,date:'2025-02-31'},doctor.cookie)).code,422);
  const created = await request('patients','POST',payload,doctor.cookie);
  assert.equal(created.code,201);
  const path = 'patients/' + created.data.id;
  assert.equal((await request(path,'GET',undefined,signup.cookie)).data.name,'Test card');
  assert.equal((await request(path,'PUT',payload,researcher.cookie)).code,403);
  assert.equal((await request(path,'DELETE',undefined,researcher.cookie)).code,403);
  assert.equal((await request(path,'PUT',{...payload,name:'Updated card'},doctor.cookie)).code,200);
  assert.equal((await request(path,'GET',undefined,doctor.cookie)).data.name,'Updated card');
  assert.equal((await request(path,'DELETE',undefined,doctor.cookie)).code,200);
  assert.equal((await request(path,'GET',undefined,doctor.cookie)).code,404);
  assert.equal((await request('logout','POST',undefined,doctor.cookie)).code,200);
  assert.equal((await request('me','GET',undefined,doctor.cookie)).code,401);
});
