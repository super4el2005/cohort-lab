const $ = id => document.getElementById(id);
const roles = {admin:'Администратор',doctor:'Врач',researcher:'Исследователь'};
const options = {
  group:['Контроль','Наблюдение'],
  diagnosis:['Гипертония','Диабет 2 типа','Бронхиальная астма','Мигрень','Без диагноза'],
  status:['Активен','Завершён','Выбыл'],
  sex:['Ж','М']
};
const labels = {
  registry:['Реестр пациентов','Найдите пациента и откройте его карточку.'],
  analytics:['Аналитика когорт','Сравните группы и проверьте полноту повторных измерений.'],
  users:['Пользователи','Учётные записи и их роли.']
};
let user, records = [], filtered = [], view, mode = 'login', page = 1, editing;
const pageSize = 12;
const fmt = new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1});
const writeAccess = () => user?.role === 'admin' || user?.role === 'doctor';

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
}

async function api(path, method = 'GET', data) {
  const response = await fetch('/api/' + path,{
    method,
    headers:data === undefined ? undefined : {'Content-Type':'application/json'},
    body:data === undefined ? undefined : JSON.stringify(data)
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error),{status:response.status});
  return result;
}

function report(error, target = 'workspaceError') {
  if (error.status === 401 && target !== 'authError') {
    user = null;
    renderSession();
    target = 'authError';
  }
  $(target).textContent = error.message || 'Ошибка соединения';
}

function authMode(next) {
  mode = next;
  const register = mode === 'register';
  $('loginMode').classList.toggle('active',!register);
  $('registerMode').classList.toggle('active',register);
  $('registerHint').hidden = !register;
  $('authTitle').textContent = register ? 'Создать аккаунт' : 'Вход в реестр';
  $('authSubmit').textContent = register ? 'Зарегистрироваться' : 'Войти';
  $('authForm').elements.password.autocomplete = register ? 'new-password' : 'current-password';
  $('authError').textContent = '';
}

function renderSession() {
  $('auth').hidden = Boolean(user);
  $('workspace').hidden = !user;
  $('account').hidden = !user;
  if (!user) {
    if ($('patientDialog').open) $('patientDialog').close();
    records = [];
    filtered = [];
    $('patients').replaceChildren();
    $('analytics').replaceChildren();
    $('userRows').replaceChildren();
    return;
  }
  $('identity').textContent = user.login + ' · ' + roles[user.role];
}

async function openWorkspace() {
  renderSession();
  await switchView(user.role === 'researcher' ? 'analytics' : 'registry');
}

async function switchView(next) {
  view = next;
  page = 1;
  $('workspaceError').textContent = '';
  const isAnalytics = view === 'analytics';
  const isUsers = view === 'users';
  const available = user.role === 'admin' ? ['registry','analytics','users']
    : user.role === 'researcher' ? ['registry','analytics'] : ['registry'];
  $('navigation').replaceChildren(...available.map(key => {
    const button = element('button',labels[key][0],key === view ? 'active' : '');
    if (key === view) button.setAttribute('aria-current','page');
    button.onclick = () => switchView(key).catch(report);
    return button;
  }));
  $('pageTitle').textContent = labels[view][0];
  $('description').textContent = labels[view][1];
  $('registry').hidden = isUsers;
  $('users').hidden = !isUsers;
  $('analytics').hidden = !isAnalytics;
  $('export').hidden = !isAnalytics;
  $('add').hidden = !writeAccess() || view !== 'registry';
  if (isUsers) {
    const users = await api('users');
    $('userRows').replaceChildren(...users.map(item => cells([item.login,roles[item.role]])));
  } else {
    await refresh();
  }
}

async function refresh() {
  records = await api('patients');
  applyFilters();
}

function applyFilters() {
  const f = Object.fromEntries(new FormData($('filters')));
  const q = f.q.trim().toLowerCase();
  filtered = records.filter(p =>
    (!q || p.name.toLowerCase().includes(q) || String(p.id) === q) &&
    Object.keys(options).every(key => !f[key] || f[key] === p[key]) &&
    (!f.min || p.age >= Number(f.min)) && (!f.max || p.age <= Number(f.max)) &&
    (!f.from || p.date >= f.from) && (!f.to || p.date <= f.to));
  renderTable();
  if (view === 'analytics') renderAnalytics();
}

function cells(values) {
  const row = element('tr');
  for (const value of values) {
    const cell = element('td');
    cell.append(value instanceof Node ? value : String(value));
    row.append(cell);
  }
  return row;
}

function renderTable() {
  const pages = Math.max(1,Math.ceil(filtered.length / pageSize));
  page = Math.min(page,pages);
  $('count').textContent = filtered.length + ' из ' + records.length;
  $('page').textContent = page + ' / ' + pages;
  $('prev').disabled = page <= 1;
  $('next').disabled = page >= pages;
  const rows = filtered.slice((page - 1) * pageSize,page * pageSize).map(p => {
    const button = element('button',p.name,'rowlink');
    button.onclick = async () => {
      try { showPatient(await api('patients/' + p.id)); } catch (error) { report(error); }
    };
    return cells([button,p.age,p.diagnosis,p.group,element('span',p.status,'pill'),p.date]);
  });
  if (!rows.length) {
    const empty = cells(['По выбранным условиям ничего не найдено']);
    empty.firstElementChild.colSpan = 6;
    rows.push(empty);
  }
  $('patients').replaceChildren(...rows);
}

function stats(rows) {
  const paired = rows.filter(p => p.followup !== null);
  const mean = values => values.length ? fmt.format(values.reduce((sum,n) => sum + n,0) / values.length) : '—';
  return {
    total:rows.length,
    paired:paired.length,
    missing:rows.length - paired.length,
    age:mean(rows.map(p => p.age)),
    baseline:mean(paired.map(p => p.baseline)),
    followup:mean(paired.map(p => p.followup)),
    change:mean(paired.map(p => p.followup - p.baseline))
  };
}

function renderAnalytics() {
  const all = stats(filtered);
  const metrics = element('div',undefined,'metrics');
  const metricsData = [['В выборке',all.total],['Средний возраст',all.age],
    ['Есть два замера',all.paired],['Без повторного замера',all.missing]];
  for (const [label,value] of metricsData) {
    const card = element('div',undefined,'metric card');
    card.append(element('span',label),element('strong',value));
    metrics.append(card);
  }
  const comparison = element('section',undefined,'card panel');
  comparison.append(element('div',undefined,'listhead'));
  comparison.firstChild.append(element('h2','Сравнение групп'));
  const box = element('div',undefined,'scroll');
  const table = element('table');
  const head = table.createTHead().insertRow();
  for (const label of ['Группа','Пациентов','Пар замеров','Пропуски','Исходное САД','Повторное САД','Δ САД']) {
    head.append(element('th',label));
  }
  const tbody = table.createTBody();
  for (const group of options.group) {
    const s = stats(filtered.filter(p => p.group === group));
    tbody.append(cells([group,s.total,s.paired,s.missing,s.baseline,s.followup,s.change]));
  }
  box.append(table);
  comparison.append(box,element('p','САД указано в мм рт. ст. Средние значения и изменение рассчитаны только по пациентам с двумя замерами. Δ = повторный замер − исходный.','muted'));
  const distribution = element('section',undefined,'card panel');
  const heading = element('div',undefined,'listhead');
  heading.append(element('h2','Включение в реестр по месяцам'));
  const monthly = new Map();
  for (const p of filtered) {
    const month = p.date.slice(0,7);
    monthly.set(month,(monthly.get(month) || 0) + 1);
  }
  const max = Math.max(1,...monthly.values());
  const bars = element('div',undefined,'bars');
  for (const [month,n] of [...monthly].sort()) {
    const bar = element('div',undefined,'bar');
    const track = element('div',undefined,'track');
    const fill = element('div',undefined,'fill');
    fill.style.width = 100 * n / max + '%';
    track.append(fill);
    bar.append(element('span',month),track,element('strong',n));
    bars.append(bar);
  }
  if (!monthly.size) bars.append(element('p','В выборке нет пациентов.'));
  distribution.append(heading,bars);
  $('analytics').replaceChildren(metrics,comparison,distribution);
  $('export').disabled = !filtered.length;
}

function csvCell(value) {
  const original = String(value ?? '');
  const safe = /^[\s]*[=+@-]|^[\t\r\n]/.test(original) ? "'" + original : original;
  return '"' + safe.replaceAll('"','""') + '"';
}

function exportCsv() {
  const header = ['ID','Возраст','Пол','Диагноз','Группа','Статус','Дата включения','Исходное САД','Повторное САД'];
  const rows = filtered.map(p => [p.id,p.age,p.sex,p.diagnosis,p.group,p.status,p.date,p.baseline,p.followup]);
  const data = [header,...rows].map(row => row.map(csvCell).join(';')).join('\r\n');
  const href = URL.createObjectURL(new Blob(['\uFEFF',data],{type:'text/csv;charset=utf-8'}));
  const link = element('a');
  link.href = href;
  link.download = 'cohort.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(href),1000);
}

function showPatient(patient) {
  editing = patient?.id;
  $('detailTitle').textContent = editing ? 'Карточка пациента #' + editing : 'Новый пациент';
  $('detailError').textContent = '';
  const form = $('patientForm');
  form.reset();
  for (const [key,value] of Object.entries(patient || {})) {
    if (form.elements.namedItem(key)) form.elements.namedItem(key).value = value ?? '';
  }
  $('patientFields').disabled = !writeAccess();
  $('patientActions').hidden = !writeAccess();
  $('remove').hidden = !editing;
  $('patientDialog').showModal();
}

for (const [key,items] of Object.entries(options)) {
  $('filters').elements[key].append(new Option('Все',''),...items.map(value => new Option(value,value)));
  $('patientForm').elements[key].append(...items.map(value => new Option(value,value)));
}
$('loginMode').onclick = () => authMode('login');
$('registerMode').onclick = () => authMode('register');
$('authForm').onsubmit = async event => {
  event.preventDefault();
  $('authError').textContent = '';
  $('authSubmit').disabled = true;
  try {
    user = await api(mode,'POST',Object.fromEntries(new FormData(event.currentTarget)));
    $('authForm').reset();
    $('filters').reset();
    await openWorkspace();
  } catch (error) {
    report(error,user ? 'workspaceError' : 'authError');
  } finally { $('authSubmit').disabled = false; }
};
$('logout').onclick = async () => {
  try {
    await api('logout','POST');
    user = null;
    authMode('login');
    renderSession();
  } catch (error) { report(error); }
};
$('filters').oninput = () => { page = 1; applyFilters(); };
$('filters').onreset = () => setTimeout(() => { page = 1; applyFilters(); },0);
$('prev').onclick = () => { page--; renderTable(); };
$('next').onclick = () => { page++; renderTable(); };
$('export').onclick = exportCsv;
$('add').onclick = () => showPatient();
$('close').onclick = () => $('patientDialog').close();
$('patientForm').onsubmit = async event => {
  event.preventDefault();
  if (!writeAccess()) return;
  const button = event.submitter;
  button.disabled = true;
  try {
    const data = Object.fromEntries(new FormData(event.currentTarget));
    for (const name of ['age','baseline','followup']) data[name] = data[name] === '' ? null : Number(data[name]);
    await api(editing ? 'patients/' + editing : 'patients',editing ? 'PUT' : 'POST',data);
    $('patientDialog').close();
    await refresh();
  } catch (error) { report(error,$('patientDialog').open ? 'detailError' : 'workspaceError'); }
  finally { button.disabled = false; }
};
$('remove').onclick = async () => {
  if (!editing || !confirm('Удалить карточку пациента #' + editing + '?')) return;
  $('remove').disabled = true;
  try {
    await api('patients/' + editing,'DELETE');
    $('patientDialog').close();
    await refresh();
  } catch (error) { report(error,$('patientDialog').open ? 'detailError' : 'workspaceError'); }
  finally { $('remove').disabled = false; }
};

api('me').then(current => {
  user = current;
  return openWorkspace();
}).catch(error => {
  if (error.status !== 401) report(error,user ? 'workspaceError' : 'authError');
});
