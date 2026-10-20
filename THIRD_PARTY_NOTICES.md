# Third-party licenses

This project's original code is licensed under MIT (see LICENSE). Dependencies are resolved from the npm registry and are not vendored into the source tree. Their own license and copyright notices remain applicable.

Direct runtime dependencies:

| Package | Version | License |
| --- | --- | --- |
| openai | 7.19.0 | Apache-2.0 |
| jose | 6.2.12 | MIT |
| zod | 4.4.3 | MIT |

Peer dependencies:

| Package | Version | License |
| --- | --- | --- |
| @deepseek-ai/cordis | 4.0.5 | MIT |
| @deepseek-ai/dsh-llm | 0.2.1-rc.2 | MIT |
| @deepseek-ai/dsh-agent | 0.2.1-rc.2 | MIT |
| @deepseek-ai/dsh-storage-domain | 0.2.1-rc.2 | MIT |
| @deepseek-ai/dsh-typert-protocol | 0.2.1-rc.2 | MIT |
| @deepseek-ai/schemastery | 3.18.5 | MIT |

The installed lockfile dependency set was checked against package metadata: all packages declare MIT or Apache-2.0. Development dependencies TypeScript and @types/node retain their respective Apache-2.0 and MIT licenses. Consult each package's license file for its complete terms and notices.

The browser bundle imports React and DSH UI primitives from the Host platform module table. React, React DOM, esbuild, and DSH client packages used for development retain their MIT licenses. These packages are not copied into the plugin browser bundle.
