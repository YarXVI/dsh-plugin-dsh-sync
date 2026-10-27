// Loopback detection for the panel route.
export function isLoopback(address) {
  const value = String(address || '').replace(/^::ffff:/i, '')
  if (!value) return false
  if (value === '::1' || value === 'localhost') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)
}
