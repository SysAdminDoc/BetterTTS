import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, '..')
const catalogPath = join(projectRoot, 'src', 'lib', 'ui-locale.catalog.json')
const sourceRoot = join(projectRoot, 'src')
const manifest = JSON.parse(readFileSync(catalogPath, 'utf8'))
const failures = []

function fail(message) {
  failures.push(message)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

if (!Number.isInteger(manifest.version) || manifest.version < 1) fail('catalog version must be a positive integer')
if (!Array.isArray(manifest.locales) || manifest.locales.length === 0) fail('catalog must declare at least one locale')
if (!isRecord(manifest.catalog)) fail('catalog must contain a catalog object')

const localeIds = new Set()
for (const locale of manifest.locales ?? []) {
  if (!isRecord(locale)) {
    fail('locale metadata must be an object')
    continue
  }
  if (typeof locale.id !== 'string' || !locale.id) fail('locale metadata has an empty id')
  if (localeIds.has(locale.id)) fail(`duplicate locale id: ${locale.id}`)
  localeIds.add(locale.id)
  if (typeof locale.tag !== 'string' || !locale.tag) fail(`locale ${locale.id} has no BCP-47 tag`)
  if (typeof locale.label !== 'string' || !locale.label.trim()) fail(`locale ${locale.id} has no label`)
  if (locale.reviewed !== true) fail(`locale ${locale.id} is not marked reviewed`)
  if (locale.direction !== 'ltr' && locale.direction !== 'rtl') fail(`locale ${locale.id} has invalid direction`)
}

const requiredTextKeys = new Set(manifest.requiredTextKeys ?? [])
const requiredPluralKeys = new Set(manifest.requiredPluralKeys ?? [])
const defaultLocale = manifest.locales?.[0]?.id
const defaultEntry = defaultLocale && manifest.catalog?.[defaultLocale]
if (!isRecord(defaultEntry) || !isRecord(defaultEntry.text) || !isRecord(defaultEntry.plurals)) {
  fail(`default locale ${defaultLocale ?? '<missing>'} must contain text and plural catalogs`)
}

const expectedTextKeys = new Set(isRecord(defaultEntry?.text) ? Object.keys(defaultEntry.text) : [])
const expectedPluralKeys = new Set(isRecord(defaultEntry?.plurals) ? Object.keys(defaultEntry.plurals) : [])
for (const key of requiredTextKeys) {
  if (!expectedTextKeys.has(key)) fail(`default catalog is missing required text key: ${key}`)
}
for (const key of requiredPluralKeys) {
  if (!expectedPluralKeys.has(key)) fail(`default catalog is missing required plural key: ${key}`)
}

for (const localeId of localeIds) {
  const entry = manifest.catalog?.[localeId]
  if (!isRecord(entry) || !isRecord(entry.text) || !isRecord(entry.plurals)) {
    fail(`locale ${localeId} is missing text/plural catalogs`)
    continue
  }
  for (const key of expectedTextKeys) {
    if (typeof entry.text[key] !== 'string' || !entry.text[key].trim()) fail(`locale ${localeId} is missing text key: ${key}`)
  }
  for (const key of Object.keys(entry.text)) {
    if (!expectedTextKeys.has(key)) fail(`locale ${localeId} has unknown text key: ${key}`)
  }
  for (const key of expectedPluralKeys) {
    const plural = entry.plurals[key]
    if (!isRecord(plural)) {
      fail(`locale ${localeId} is missing plural key: ${key}`)
      continue
    }
    let categories = ['other']
    try {
      categories = new Intl.PluralRules(manifest.locales.find((locale) => locale.id === localeId)?.tag).resolvedOptions().pluralCategories
    } catch {
      fail(`locale ${localeId} has an invalid plural-rules tag`)
    }
    for (const category of categories) {
      if (typeof plural[category] !== 'string' || !plural[category].trim()) fail(`locale ${localeId} is missing ${category} plural form for: ${key}`)
    }
  }
}

for (const localeId of Object.keys(manifest.catalog ?? {})) {
  if (!localeIds.has(localeId)) fail(`catalog has no metadata for locale: ${localeId}`)
}

function sourceFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filePath = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(filePath))
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) files.push(filePath)
  }
  return files
}

const usedTextKeys = new Set()
const usedPluralKeys = new Set()
for (const filePath of sourceFiles(sourceRoot)) {
  const source = readFileSync(filePath, 'utf8')
  const displayPath = relative(projectRoot, filePath)
  for (const match of source.matchAll(/\buiText\s*\(\s*[^,\n]+,\s*(['"])([^'"]+)\1/g)) {
    const key = match[2]
    usedTextKeys.add(key)
    if (!expectedTextKeys.has(key)) fail(`${displayPath} uses an unknown UI text key: ${key}`)
  }
  for (const match of source.matchAll(/\buiPlural\s*\(\s*[^,\n]+,\s*(['"])([^'"]+)\1/g)) {
    const key = match[2]
    usedPluralKeys.add(key)
    if (!expectedPluralKeys.has(key)) fail(`${displayPath} uses an unknown UI plural key: ${key}`)
  }
}

for (const key of usedTextKeys) {
  if (!requiredTextKeys.has(key)) fail(`production UI text key is not listed in requiredTextKeys: ${key}`)
}
for (const key of usedPluralKeys) {
  if (!requiredPluralKeys.has(key)) fail(`production UI plural key is not listed in requiredPluralKeys: ${key}`)
}

if (failures.length > 0) {
  console.error(`UI locale catalog failed with ${failures.length} issue${failures.length === 1 ? '' : 's'}:`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(`UI locale catalog passed: ${localeIds.size} reviewed locale${localeIds.size === 1 ? '' : 's'}, ${expectedTextKeys.size} text keys, ${expectedPluralKeys.size} plural keys, ${usedTextKeys.size + usedPluralKeys.size} production call keys.`)
}
