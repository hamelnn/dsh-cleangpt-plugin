// Isolated synthetic backend. No real OpenAI authentication or inference is allowed.
import { appendFile } from 'node:fs/promises';
const original=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
 const url=String(input instanceof Request?input.url:input);
 if(url.startsWith('https://auth.openai.com/'))throw new Error('Real authorization disabled in synthetic regression');
 if(!url.startsWith('https://api.openai.com/'))return original(input,init);
 if(url.endsWith('/models'))return Response.json({models:[{slug:'mock-gpt',display_name:'Synthetic GPT',visibility:'list'}]});
 if(url.endsWith('/responses')){
 const body=JSON.parse(init.body);await appendFile(process.env.DSH_TEST_CAPTURE,JSON.stringify(body)+'\n');
 const output=[{type:'message',id:'msg_mock',role:'assistant',status:'completed',content:[{type:'output_text',text:'Synthetic response. No external inference.',annotations:[]}]}];
 const events=[{type:'response.output_text.delta',item_id:'msg_mock',content_index:0,output_index:0,delta:'Synthetic response. No external inference.'},{type:'response.completed',response:{id:'resp_mock',status:'completed',output}}];
 return new Response(events.map(x=>`event: ${x.type}\ndata: ${JSON.stringify(x)}\n\n`).join(''),{headers:{'Content-Type':'text/event-stream'}});
 }
 throw new Error('Unexpected synthetic endpoint');
};
