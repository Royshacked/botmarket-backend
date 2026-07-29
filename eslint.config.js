import js from '@eslint/js'
import globals from 'globals'

// Backend lint config. The reason this exists: two agents shipped broken because a refactor left
// behind identifiers that no longer resolved (`tools`/`toolHandlers` in the analyst, `model`/
// `provider` in idea). Both threw before the first token and surfaced to the client as the
// generic "Streaming failed" — invisible to the test suite, instant for `no-undef`. That rule is
// the point of this file; everything else is kept quiet enough that `npm run lint` stays green
// and therefore stays useful as a gate.
export default [
    {
        ignores: ['node_modules/**', 'public/**', 'data/**'],
    },
    js.configs.recommended,
    {
        // .mjs too — scripts/ is written that way, and a glob that misses them leaves those files
        // with no Node globals at all (every `console` reads as undefined).
        files: ['**/*.js', '**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: globals.node,
        },
        // The codebase predates this config and carries `eslint-disable no-unused-vars` comments
        // that `args: 'none'` below makes redundant. Reporting them would be 18 lines of noise
        // about nothing.
        linterOptions: { reportUnusedDisableDirectives: 'off' },
        rules: {
            // The bug class this config was added for. Never downgrade — `npm run lint` failing
            // on this is the whole point.
            'no-undef': 'error',

            // The 19 pre-existing dead imports/consts this started as warnings for are cleared,
            // so this is an error now — a dead import is how a refactor's leftovers hide.
            // Unused caught errors and unused args are idiomatic here (`catch { }` shapes, and
            // handlers that must match a fixed signature), so those never report.
            'no-unused-vars': ['error', {
                args: 'none',
                caughtErrors: 'none',
                ignoreRestSiblings: true,
                varsIgnorePattern: '^_',
            }],

            // An empty block is usually a deliberate "malformed → ignore" in the emit parsers.
            'no-empty': ['error', { allowEmptyCatch: true }],
        },
    },
    {
        // Playwright renders our own KLineCharts in a real browser: the callbacks passed to
        // page.evaluate() execute THERE, not in Node, so window/document/klinecharts are legitimate.
        files: ['services/chartRender/**/*.js'],
        languageOptions: { globals: { ...globals.node, ...globals.browser, klinecharts: 'readonly' } },
    },
]
