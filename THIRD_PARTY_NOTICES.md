# Bundled browser dependencies

The browser client bundles the following exact packages. The build metafile was
used to identify code that entered `packages/report-review/lib/client.js`; every
listed package declares MIT and supplied a LICENSE file. Verbatim license files
are retained under `third_party/licenses/`.

| Package | Version | License |
| --- | --- | --- |
| `@codemirror/autocomplete` | 6.20.3 | MIT |
| `@codemirror/commands` | 6.11.0 | MIT |
| `@codemirror/lang-css` | 6.3.1 | MIT |
| `@codemirror/lang-html` | 6.4.12 | MIT |
| `@codemirror/lang-javascript` | 6.2.5 | MIT |
| `@codemirror/lang-markdown` | 6.5.2 | MIT |
| `@codemirror/language` | 6.12.4 | MIT |
| `@codemirror/merge` | 6.12.2 | MIT |
| `@codemirror/state` | 6.7.4 | MIT |
| `@codemirror/view` | 6.43.11 | MIT |
| `@lezer/common` | 1.5.2 | MIT |
| `@lezer/css` | 1.3.6 | MIT |
| `@lezer/highlight` | 1.2.3 | MIT |
| `@lezer/html` | 1.3.13 | MIT |
| `@lezer/javascript` | 1.5.4 | MIT |
| `@lezer/lr` | 1.4.10 | MIT |
| `@lezer/markdown` | 1.7.2 | MIT |
| `@marijn/find-cluster-break` | 1.0.4 | MIT |
| `crelt` | 1.0.7 | MIT |
| `style-mod` | 4.1.3 | MIT |
| `w3c-keyname` | 2.2.8 | MIT |

React and `react/jsx-runtime` are external module-table inputs provided by the
DSH Web shell and are not copied into this package. Esbuild is a development
tool and is not shipped.
