/** Verify persisted Host data after a full server restart with a fresh browser. */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const { chromium }=createRequire(`${process.env.DSH_TEST_RUNTIME}/package.json`)('playwright');
const browser=await chromium.launch({...(process.env.DSH_TEST_BROWSER?{executablePath:process.env.DSH_TEST_BROWSER}:{}),headless:true,args:['--no-sandbox']});
let page;
try {
 page=await browser.newPage({viewport:{width:1440,height:1000}});
 await page.goto((await readFile(process.env.DSH_TEST_LOG,'utf8')).match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)[0]);
 // A fresh browser may default to the runner's other workspace. Expand the tested group explicitly.
 const group=page.locator('[role="treeitem"][data-row-key^="workspace:"]').filter({has:page.getByText('workspace',{exact:true})});
 await group.waitFor();
 const sessionA=page.getByRole('treeitem').filter({hasText:'Session A'});
 // Sidebar hydration can restore collapsed state after the first render.
 // Observe the target rather than assuming one click has completed restoration.
 for(let i=0;i<100 && !await sessionA.isVisible();i++){
  if(await group.getAttribute('aria-expanded')==='false')await group.click();
  await page.waitForTimeout(100);
 }
 await sessionA.click({timeout:5000});
 await page.getByRole('button',{name:/reasoning effort 高/}).waitFor();
 const speed=page.getByRole('button',{name:/^ChatGPT 加速：/});
 await page.waitForFunction(()=>document.querySelector('[data-cleangpt-speed]')?.getAttribute('data-cleangpt-speed')==='priority');
 assert.equal(await speed.getAttribute('data-cleangpt-speed'),'priority');
 await page.getByRole('treeitem').filter({hasText:'Session B'}).click();
 await page.getByRole('button',{name:/reasoning effort 低/}).waitFor();
 await page.waitForFunction(()=>document.querySelector('[data-cleangpt-speed]')?.getAttribute('data-cleangpt-speed')==='default');
 assert.equal(await speed.getAttribute('data-cleangpt-speed'),'default');
 await page.screenshot({path:`${process.env.DSH_TEST_ARTIFACTS}/host-restart-restored.png`});
 console.log('PASS: Host restart and fresh browser preserve A/B native effort and speed');
} catch(error) {
 if(page){
  console.log('Restart sidebar rows:',await page.getByRole('treeitem').allTextContents());
  await page.screenshot({path:`${process.env.DSH_TEST_ARTIFACTS}/host-restart-failure.png`});
 }
 throw error;
} finally {await browser.close();}
