/** Verify persisted Host data after a full server restart with a fresh browser. */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const { chromium }=createRequire(`${process.env.DSH_TEST_RUNTIME}/package.json`)('playwright');
const browser=await chromium.launch({...(process.env.DSH_TEST_BROWSER?{executablePath:process.env.DSH_TEST_BROWSER}:{}),headless:true,args:['--no-sandbox']});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 await page.goto((await readFile(process.env.DSH_TEST_LOG,'utf8')).match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)[0]);
 // A fresh browser may default to the runner's other workspace. Expand the tested group explicitly.
 const group=page.locator('[role="treeitem"][data-row-key^="workspace:"]').filter({has:page.getByText('workspace',{exact:true})});
 await group.waitFor();if(await group.getAttribute('aria-expanded')==='false')await group.click();
 await page.getByRole('treeitem').filter({hasText:'Session A'}).click();
 await page.getByRole('button',{name:/reasoning effort high/}).waitFor();
 const speed=page.getByRole('combobox',{name:'ChatGPT speed'});
 await page.waitForFunction(()=>document.querySelector('[aria-label="ChatGPT speed"]')?.value==='priority');
 assert.equal(await speed.inputValue(),'priority');
 await page.getByRole('treeitem').filter({hasText:'Session B'}).click();
 await page.getByRole('button',{name:/reasoning effort low/}).waitFor();
 await page.waitForFunction(()=>document.querySelector('[aria-label="ChatGPT speed"]')?.value==='default');
 assert.equal(await speed.inputValue(),'default');
 await page.screenshot({path:`${process.env.DSH_TEST_ARTIFACTS}/host-restart-restored.png`});
 console.log('PASS: Host restart and fresh browser preserve A/B native effort and speed');
} finally {await browser.close();}
