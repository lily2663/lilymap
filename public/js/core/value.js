export function sameValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key]));
  }
  return false;
}

export function selectOptionIndex(definition, value) {
  return (definition?.options || []).findIndex((option) => sameValue(option?.value, value));
}

export function selectOptionValue(definition, index) {
  const option = definition?.options?.[Number(index)];
  return option && Object.hasOwn(option, 'value') ? option.value : undefined;
}

export function selectOptionLabel(option) {
  if (option?.label != null) return String(option.label);
  if (typeof option?.value === 'string') return option.value;
  try { return JSON.stringify(option?.value); } catch { return String(option?.value ?? ''); }
}
