export async function mediatorErrorMessage(error) {
  const response = error.context;
  if (typeof response?.text === 'function') {
    let text;
    try {
      text = (await response.text()).trim();
    } catch (readError) {
      console.warn('Odpoveď mediátora sa nepodarilo prečítať.', readError);
    }
    if (text) {
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        return text;
      }
      if (typeof payload === 'string') return payload;
      if (payload && typeof payload === 'object') {
        for (const candidate of [payload.error, payload.message, payload.error_description, payload.error?.message]) {
          if (typeof candidate === 'string' && candidate.trim()) return candidate;
        }
      }
      return text;
    }
    if (response.status) return `${error.message} (HTTP ${response.status})`;
  }
  return error.message;
}
