import {createServer} from 'node:http';
import {createHash,timingSafeEqual} from 'node:crypto';
import {db} from './db.js';
const key=process.env.STAFF_API_TOKEN;
if (!key || key.length<32) throw new Error('Set STAFF_API_TOKEN (at least 32 characters)');
const digest=s=>createHash('sha256').update(s).digest();
const expected=digest('Bearer '+key);
const string=(max)=>v=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
const integer=(min,max)=>v=>Number.isInteger(v)&&v>=min&&v<=max;
const choice=(...values)=>v=>values.includes(v);
const id=integer(1,2147483647);
const resources={
 inventory:{required:{stock_number:string(60),year:integer(1886,2100),make:string(80),model:string(80),mileage:integer(0,2147483647),asking_price_cents:integer(0,2147483647),availability:choice('available','pending','sold','unknown')},
 optional:{history_summary:string(2000),inspection_notes:string(2000),availability_verified_at:v=>typeof v==='string'&&v.length<=35&&Number.isFinite(Date.parse(v))}},
 customers:{required:{name:string(160)},optional:{email:string(254),phone:string(50)}},
 leads:{required:{customer_id:id,inquiry:string(4000)},optional:{vehicle_id:id,status:choice('new','contacted','qualified','closed')}}
};
const own=(o,k)=>Object.hasOwn(o,k);
function reply(res,status,data){
 res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});
 res.end(JSON.stringify(data));
}
async function read(req){
 let data='', bytes=0;
 if (!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')) throw Object.assign(new Error(),{http:415});
 for await (const chunk of req){bytes+=chunk.length;if(bytes>16384)return null;data+=chunk;}
 try{return JSON.parse(data);}catch{return null;}
}
const server=createServer(async(req,res)=>{
 const send=(s,d)=>reply(res,s,d);
 try {
 const url=new URL(req.url,'http://localhost');
 if (req.method==='GET'&&url.pathname==='/health'){
  try {await db.query('SELECT 1');return send(200,{ok:true});}
  catch{return send(503,{ok:false});}
 }
 if(!timingSafeEqual(expected,digest(req.headers.authorization||'')))return send(401,{error:'Unauthorized'});
 const match=/^\/api\/(inventory|customers|leads)(?:\/([1-9]\d*))?$/.exec(url.pathname);
 if(!match)return send(404,{error:'Not found'});
 const [,table,rawId]=match;
 const rowId=rawId?Number(rawId):null;
 if(rawId&&!id(rowId))return send(400,{error:'Invalid ID'});
 if(req.method==='GET'){
  if(rowId){
   const {rows}=await db.query(`SELECT * FROM ${table} WHERE id=$1`,[rowId]);
   return rows[0]?send(200,rows[0]):send(404,{error:'Not found'});
  }
  const limit=Number(url.searchParams.get('limit')??50),offset=Number(url.searchParams.get('offset')??0);
  if(!integer(1,100)(limit)||!integer(0,2147483647)(offset))return send(400,{error:'Invalid pagination'});
  const {rows}=await db.query(`SELECT * FROM ${table} ORDER BY id LIMIT $1 OFFSET $2`,[limit,offset]);
  return send(200,{items:rows,limit,offset});
 }
 const create=req.method==='POST'&&!rowId, update=req.method==='PATCH'&&rowId;
 if(!create&&!update){res.setHeader('Allow',rowId?'GET, PATCH':'GET, POST');return send(405,{error:'Method not allowed'});}
 const body=await read(req);
 if(!body||typeof body!=='object'||Array.isArray(body)||!Object.keys(body).length)return send(400,{error:'Expected a nonempty JSON object (16 KB maximum)'});
 const {required,optional}=resources[table];
 if(create&&Object.keys(required).some(k=>!own(body,k)))return send(400,{error:'Missing required fields',required:Object.keys(required)});
 const fields=Object.keys(body),values=[];
 for(const k of fields){
  const v=body[k];
  if(!((own(required,k)&&required[k](v))||(own(optional,k)&&(v===null?k!=='status':optional[k](v)))))return send(400,{error:'Invalid or unknown field',field:k});
  values.push(typeof v==='string'?v.trim():v);
 }
 const slots=fields.map((_,i)=>'$'+(i+1));
 const sql=create?`INSERT INTO ${table} (${fields.join(',')}) VALUES (${slots.join(',')}) RETURNING *`:
   `UPDATE ${table} SET ${fields.map((f,i)=>f+'='+slots[i]).join(',')} WHERE id=$${fields.length+1} RETURNING *`;
 const {rows}=await db.query(sql,create?values:[...values,rowId]);
 return rows[0]?send(create?201:200,rows[0]):send(404,{error:'Not found'});
 }catch(e){
  if(e.http===415)return send(415,{error:'Use application/json'});
  if(e.code==='23505')return send(409,{error:'Duplicate record'});
  if(e.code==='23503'||e.code==='23502'||e.code==='23514'||e.code==='22008')return send(400,{error:'Invalid record or related ID'});
  console.error('Request failed',e.code||e.name);
  return send(500,{error:'Internal error'});
 }
});
db.on('error',e=>console.error('Database pool error',e.code||e.name));
server.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('Dealer AI API listening'));
process.on('SIGTERM',()=>server.close(()=>db.end()));
