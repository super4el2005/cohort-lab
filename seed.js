export const diagnoses = ['Гипертония', 'Диабет 2 типа', 'Бронхиальная астма', 'Мигрень', 'Без диагноза'];
export const groups = ['Контроль', 'Наблюдение'];
export const statuses = ['Активен', 'Завершён', 'Выбыл'];
export const sexes = ['Ж', 'М'];

export function mockPatients() {
  let state = 48271;
  const pick = (n) => {
    state = (state * 16807) % 2147483647;
    return state % n;
  };
  return Array.from({length: 100}, (_, i) => {
    const sex = sexes[pick(2)];
    const group = groups[pick(2)];
    const baseline = 110 + pick(56);
    const date = new Date(Date.UTC(2025, 0, 1 + pick(365))).toISOString().slice(0, 10);
    return {
      name: 'Пациент ' + String(i + 1).padStart(3, '0'),
      sex, group, baseline, date,
      age: 20 + pick(61),
      diagnosis: diagnoses[pick(diagnoses.length)],
      status: statuses[pick(statuses.length)],
      followup: pick(8) ? baseline - (group === 'Наблюдение' ? 8 : 3) + pick(15) - 7 : null
    };
  });
}
