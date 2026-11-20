const $ = id => document.getElementById(id);
const roles = {admin:'Администратор',doctor:'Врач',researcher:'Исследователь'};
const options = {
  group:['Контроль','Наблюдение'],
  diagnosis:['Гипертония','Диабет 2 типа','Бронхиальная астма','Мигрень','Без диагноза'],
  status:['Активен','Завершён','Выбыл'],
  sex:['Ж','М']
};
const labels = {registry:'Пациенты',analytics:'Аналитика когорт',users:'Пользователи'};
const filterLabels = {
  q:'Поиск',group:'Группа',status:'Статус',diagnosis:'Диагноз',sex:'Пол',
  min:'Возраст от',max:'Возраст до',from:'Включён с',to:'Включён по'
};
const allOptions = {group:'Все группы',status:'Все статусы',diagnosis:'Все диагнозы',sex:'Любой пол'};
const statusClasses = {'Активен':'active','Выбыл':'withdrawn'};
let user, records = [], filtered = [], view, mode = 'login', page = 1, editing;
let pageSize = 10, sortKey = 'name', sortOrder = 1, loading = false, loadSequence = 0;
const collator = new Intl.Collator('ru',{numeric:true,sensitivity:'base'});
const monthFormat = new Intl.DateTimeFormat('ru-RU',{month:'short',timeZone:'UTC'});
const displayDate = iso => iso.split('-').reverse().join('.');
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
  $('loginHeader').hidden = Boolean(user);
  $('loginMain').hidden = Boolean(user);
  $('workspace').hidden = !user;
  if (!user) {
    loadSequence++;
    if ($('patientDialog').open) $('patientDialog').close();
    records = [];
    filtered = [];
    $('patients').replaceChildren();
    $('analytics').replaceChildren();
    $('userRows').replaceChildren();
    return;
  }
  $('identity').textContent = user.login;
  $('accountRole').textContent = roles[user.role];
  $('avatar').textContent = user.login.slice(0,1).toUpperCase();
}

async function openWorkspace() {
  renderSession();
  await switchView(user.role === 'researcher' ? 'analytics' : 'registry');
}

async function switchView(next, moveFocus = false) {
  view = next;
  page = 1;
  $('workspaceError').textContent = '';
  $('notice').textContent = '';
  const isAnalytics = view === 'analytics';
  const isUsers = view === 'users';
  const available = user.role === 'admin' ? ['registry','analytics','users']
    : user.role === 'researcher' ? ['analytics','registry'] : ['registry'];
  $('navigation').replaceChildren(...available.map(key => {
    const button = element('button',labels[key]);
    button.type = 'button';
    if (key === view) button.setAttribute('aria-current','page');
    button.onclick = () => {
      if (key !== view) switchView(key,true).catch(report);
    };
    return button;
  }));
  $('pageTitle').textContent = view === 'registry' ? 'Реестр пациентов' : labels[view];
  $('description').textContent = view === 'registry' ? 'Синтетические данные' : '';
  $('description').hidden = view !== 'registry';
  $('listingTitle').textContent = isAnalytics ? 'Пациенты в выборке' : 'Список пациентов';
  $('registry').hidden = isUsers;
  $('users').hidden = !isUsers;
  $('analytics').hidden = !isAnalytics;
  $('export').hidden = !isAnalytics;
  $('add').hidden = !writeAccess() || view !== 'registry';
  if (moveFocus) $('pageTitle').focus();
  if (isUsers) {
    const sequence = ++loadSequence;
    $('users').setAttribute('aria-busy','true');
    $('userRows').replaceChildren(messageRow('Загрузка пользователей…',2));
    try {
      const users = await api('users');
      if (sequence === loadSequence) {
        $('userRows').replaceChildren(...users.map(item => cells([item.login,roles[item.role]])));
      }
    } catch (error) {
      if (sequence === loadSequence) {
        $('userRows').replaceChildren();
        throw error;
      }
    } finally {
      if (sequence === loadSequence) $('users').removeAttribute('aria-busy');
    }
  } else {
    await refresh();
  }
}

async function refresh() {
  const sequence = ++loadSequence;
  loading = true;
  $('registry').setAttribute('aria-busy','true');
  $('export').disabled = true;
  $('count').textContent = '';
  $('analytics').replaceChildren();
  renderTable();
  try {
    const patients = await api('patients');
    if (sequence !== loadSequence) return;
    records = patients;
    loading = false;
    applyFilters();
  } catch (error) {
    if (sequence === loadSequence) {
      loading = false;
      records = [];
      filtered = [];
      $('patients').replaceChildren(messageRow('Не удалось загрузить пациентов',6));
      throw error;
    }
  } finally {
    if (sequence === loadSequence) $('registry').removeAttribute('aria-busy');
  }
}

function applyFilters() {
  const f = Object.fromEntries(new FormData($('filters')));
  const q = f.q.trim().toLocaleLowerCase('ru').replace(/\s+/g,' ');
  const byId = /^#?\d+$/.test(q) ? Number(q.replace('#','')) : null;
  filtered = records.filter(p =>
    (!q || p.name.toLocaleLowerCase('ru').replace(/\s+/g,' ').includes(q) || p.id === byId) &&
    Object.keys(options).every(key => !f[key] || f[key] === p[key]) &&
    (!f.min || p.age >= Number(f.min)) && (!f.max || p.age <= Number(f.max)) &&
    (!f.from || p.date >= f.from) && (!f.to || p.date <= f.to));
  filtered.sort((a,b) => sortOrder * (sortKey === 'age' ? a.age - b.age : collator.compare(a[sortKey],b[sortKey])) || a.id - b.id);

  renderFilterChips(f);
  renderTable();
  if (view === 'analytics' && !loading) renderAnalytics();
}

function renderFilterChips(filters) {
  const active = Object.entries(filters).filter(([,value]) => value.trim());
  $('filterSelection').hidden = !active.length;
  $('filterChips').replaceChildren(...active.map(([key,value]) => {
    const shown = key === 'from' || key === 'to' ? displayDate(value) : value.trim();
    const label = filterLabels[key] + ': ' + shown;
    const button = element('button',label,'chip');
    button.type = 'button';
    button.setAttribute('aria-label','Убрать фильтр «' + label + '»');
    const icon = element('span','×');
    icon.setAttribute('aria-hidden','true');
    button.append(icon);
    button.onclick = () => {
      const input = $('filters').elements[key];
      input.value = '';
      page = 1;
      applyFilters();
      (input.closest('[hidden]') ? $('moreFilters') : input).focus();
    };
    return button;
  }));
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

function messageRow(message, columns) {
  const row = cells([message]);
  row.firstElementChild.colSpan = columns;
  row.firstElementChild.className = 'empty-row';
  return row;
}

function renderTable() {
  const total = filtered.length;
  const pages = Math.max(1,Math.ceil(total / pageSize));
  page = Math.min(page,pages);
  const start = (page - 1) * pageSize;
  $('count').textContent = loading ? '' : fmt.format(total) + ' из ' + fmt.format(records.length);
  $('page').textContent = total && !loading ? (start + 1) + '–' + Math.min(start + pageSize,total) + ' из ' + total : '0 строк';
  $('prev').disabled = loading || page <= 1;
  $('next').disabled = loading || page >= pages;
  for (const header of document.querySelectorAll('th[data-sort]')) {
    if (header.dataset.sort === sortKey) header.setAttribute('aria-sort',sortOrder === 1 ? 'ascending' : 'descending');
    else header.removeAttribute('aria-sort');
    header.querySelector('span').textContent = header.dataset.sort === sortKey ? (sortOrder === 1 ? '↑' : '↓') : '↕';
  }
  if (loading) {
    $('patients').replaceChildren(messageRow('Загрузка пациентов…',6));
    return;
  }
  const rows = filtered.slice(start,start + pageSize).map(p => {
    const button = element('button',undefined,'patient-link');
    button.type = 'button';
    button.append(element('span',p.name,'patient-name'),element('span','#' + p.id,'cell-meta'));
    button.onclick = async () => {
      const session = user;
      const section = view;
      button.disabled = true;
      try {
        const patient = await api('patients/' + p.id);
        if (user === session && view === section) showPatient(patient);
      } catch (error) {
        if (user === session && view === section) report(error);
      } finally {
        button.disabled = false;
      }
    };
    const status = element('span',p.status,'status');
    if (statusClasses[p.status]) status.classList.add(statusClasses[p.status]);
    const row = cells([button,p.diagnosis,p.age,p.group,status,displayDate(p.date)]);
    row.children[2].className = 'number';
    return row;
  });
  if (!total) {
    const row = messageRow(records.length ? 'По этим фильтрам пациентов нет' : 'В реестре пока нет пациентов',6);
    if (records.length) {
      const reset = element('button','Сбросить фильтры','text-button');
      reset.type = 'button';
      reset.onclick = () => { $('filters').reset(); $('filters').elements.q.focus(); };
      row.firstElementChild.append(reset);
    }
    rows.push(row);
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

function panel(title, subtitle) {
  const section = element('section',undefined,'surface analysis-panel');
  const heading = element('div',undefined,'section-head');
  heading.append(element('h2',title));
  if (subtitle) heading.append(element('span',subtitle));
  section.append(heading);
  return section;
}

function renderAnalytics() {
  const all = stats(filtered);
  const grid = element('div',undefined,'analytics-grid');
  const metrics = element('div',undefined,'metrics');
  const metricsData = [
    ['Пациенты',fmt.format(all.total)],
    ['Средний возраст',all.age],
    ['Пар замеров',fmt.format(all.paired)],
    ['Без повторного замера',fmt.format(all.missing),all.total ? fmt.format(100 * all.missing / all.total) + '% выборки' : '']
  ];
  for (const [label,value,detail] of metricsData) {
    const card = element('div',undefined,'metric surface');
    card.append(element('span',label),element('strong',value));
    if (detail) card.append(element('small',detail));
    metrics.append(card);
  }
  grid.append(metrics,renderComparison(),renderEnrollment());
  $('analytics').replaceChildren(grid);
  $('export').disabled = !filtered.length;
}

function renderComparison() {
  const comparison = panel('Сравнение групп','САД, мм рт. ст.');
  const box = element('div',undefined,'table-scroll');
  const table = element('table',undefined,'comparison-table');
  const head = table.createTHead().insertRow();
  for (const label of ['Группа','Пациентов','Пар','Пропуски','Исходное','Повторное','Δ']) {
    const th = element('th',label);
    th.scope = 'col';
    if (label !== 'Группа') th.className = 'number';
    head.append(th);
  }
  const tbody = table.createTBody();
  for (const group of options.group) {
    const s = stats(filtered.filter(p => p.group === group));
    const row = cells([s.total,s.paired,s.missing,s.baseline,s.followup,s.change]);
    for (const cell of row.children) cell.classList.add('number');
    row.lastElementChild.classList.add('delta');
    const label = element('th',group);
    label.scope = 'row';
    row.prepend(label);
    tbody.append(row);
  }
  box.append(table);
  comparison.append(box,element('p','Средние рассчитаны по пациентам с двумя замерами. Δ = повторный замер − исходный.','method-note'));
  return comparison;
}

function renderEnrollment() {
  const section = panel('Включение по месяцам');
  const counts = new Map();
  for (const p of filtered) {
    const month = p.date.slice(0,7);
    counts.set(month,(counts.get(month) || 0) + 1);
  }
  const months = [...counts.keys()].sort();
  if (!months.length) {
    section.append(element('p','В выбранной выборке нет пациентов.','chart-empty'));
    return section;
  }
  const first = new Date(months[0] + '-01T00:00:00Z');
  const last = new Date(months.at(-1) + '-01T00:00:00Z');
  const span = (last.getUTCFullYear() - first.getUTCFullYear()) * 12 + last.getUTCMonth() - first.getUTCMonth() + 1;
  const displayMonths = span <= 18
    ? Array.from({length:span},(_,i) => {
        const date = new Date(first);
        date.setUTCMonth(first.getUTCMonth() + i);
        return date.toISOString().slice(0,7);
      })
    : months;
  const singleYear = first.getUTCFullYear() === last.getUTCFullYear();
  if (singleYear) section.firstElementChild.append(element('span',first.getUTCFullYear()));
  const max = Math.max(...counts.values());
  const chart = element('ul',undefined,'chart');
  chart.setAttribute('aria-label','Число пациентов по месяцам');
  for (const month of displayMonths) {
    const n = counts.get(month) || 0;
    const labelText = monthFormat.format(new Date(month + '-01T00:00:00Z')).replace('.', '');
    const item = element('li');
    const stack = element('div',undefined,'chart-stack');
    stack.append(element('span',fmt.format(n),'chart-count'));
    const bar = element('span',undefined,'chart-bar');
    bar.setAttribute('aria-hidden','true');
    bar.style.setProperty('--bar-height',Math.round(n / max * 82) + 'px');
    stack.append(bar);
    const label = element('span',singleYear ? labelText : labelText + ' ’' + month.slice(2,4),'chart-label');
    label.title = month;
    item.append(stack,label);
    chart.append(item);
  }
  const scroll = element('div',undefined,'chart-scroll');
  scroll.append(chart);
  section.append(scroll);
  if (span > 18 && months.length < span) {
    section.append(element('p','Показаны только месяцы с включениями.','method-note'));
  }
  return section;
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
  $('detailTitle').textContent = patient?.name || 'Новый пациент';
  $('detailId').textContent = editing ? 'Карточка #' + editing : '';
  $('detailId').hidden = !editing;
  $('detailError').textContent = '';
  const form = $('patientForm');
  form.reset();
  for (const [key,value] of Object.entries(patient || {})) {
    if (form.elements.namedItem(key)) form.elements.namedItem(key).value = value ?? '';
  }
  const canWrite = writeAccess();
  $('patientFields').disabled = !canWrite;
  $('patientFields').hidden = !canWrite;
  $('patientActions').hidden = !canWrite;
  $('patientReadout').hidden = canWrite;
  $('patientReadout').replaceChildren();
  if (!canWrite && patient) {
    const readings = [
      ['Возраст',patient.age],['Пол',patient.sex],['Диагноз',patient.diagnosis],
      ['Группа',patient.group],['Статус',patient.status],['Дата включения',displayDate(patient.date)],
      ['Исходное САД',patient.baseline + ' мм рт. ст.'],
      ['Повторное САД',patient.followup === null ? 'Нет замера' : patient.followup + ' мм рт. ст.']
    ];
    for (const [label,value] of readings) {
      const field = element('div');
      field.append(element('dt',label),element('dd',value));
      $('patientReadout').append(field);
    }
  }
  $('remove').hidden = !editing;
  const dialog = $('patientDialog');
  if (!dialog.open) dialog.showModal();
  form.querySelector('.drawer-content').scrollTop = 0;
  if (canWrite) form.elements.name.focus();
}

for (const [key,items] of Object.entries(options)) {
  $('filters').elements[key].append(new Option(allOptions[key],''),...items.map(value => new Option(value,value)));
  $('patientForm').elements[key].append(...items.map(value => new Option(value,value)));
}
for (const header of document.querySelectorAll('th[data-sort]')) {
  header.querySelector('button').onclick = () => {
    const key = header.dataset.sort;
    sortOrder = key === sortKey ? -sortOrder : 1;
    sortKey = key;
    page = 1;
    applyFilters();
  };
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
    setAdvancedFilters(false);
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
function setAdvancedFilters(expanded) {
  $('advancedFilters').hidden = !expanded;
  $('moreFilters').setAttribute('aria-expanded',String(expanded));
}
$('moreFilters').onclick = () => setAdvancedFilters($('advancedFilters').hidden);
$('filters').onsubmit = event => event.preventDefault();
$('filters').oninput = () => { page = 1; applyFilters(); };
$('filters').onreset = () => setTimeout(() => {
  page = 1;
  if (user && view !== 'users') applyFilters();
},0);
$('clearFilters').onclick = () => $('filters').elements.q.focus();
$('pageSize').onchange = event => {
  pageSize = Number(event.currentTarget.value);
  page = 1;
  renderTable();
};
$('prev').onclick = () => { page--; renderTable(); };
$('next').onclick = () => { page++; renderTable(); };
$('export').onclick = exportCsv;
$('add').onclick = () => showPatient();
$('close').onclick = $('cancelPatient').onclick = () => $('patientDialog').close();
$('patientForm').onsubmit = async event => {
  event.preventDefault();
  if (!writeAccess()) return;
  const button = event.submitter;
  button.disabled = true;
  try {
    const data = Object.fromEntries(new FormData(event.currentTarget));
    for (const name of ['age','baseline','followup']) data[name] = data[name] === '' ? null : Number(data[name]);
    const id = editing;
    const saved = await api(id ? 'patients/' + id : 'patients',id ? 'PUT' : 'POST',data);
    $('patientDialog').close();
    await refresh();
    $('notice').textContent = 'Карточка #' + saved.id + (id ? ' обновлена' : ' добавлена');
  } catch (error) { report(error,$('patientDialog').open ? 'detailError' : 'workspaceError'); }
  finally { button.disabled = false; }
};
$('remove').onclick = async () => {
  if (!editing || !confirm('Удалить карточку пациента #' + editing + '?')) return;
  $('remove').disabled = true;
  try {
    const id = editing;
    await api('patients/' + id,'DELETE');
    $('patientDialog').close();
    await refresh();
    $('notice').textContent = 'Карточка #' + id + ' удалена';
  } catch (error) { report(error,$('patientDialog').open ? 'detailError' : 'workspaceError'); }
  finally { $('remove').disabled = false; }
};

api('me').then(current => {
  user = current;
  return openWorkspace();
}).catch(error => {
  if (error.status !== 401) report(error,user ? 'workspaceError' : 'authError');
});
