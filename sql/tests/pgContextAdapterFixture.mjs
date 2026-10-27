// Adaptador de prueba exclusivamente PostgreSQL local por Unix socket.
import{pathToFileURL}from'node:url';
const socket=process.env.PADBOL_TEST_PG_SOCKET,database=process.env.PADBOL_TEST_PG_DATABASE;
if(!socket?.startsWith('/tmp/pb-support-pg-')||!/^pb_context_[a-z0-9_]+$/.test(database||''))throw Error('EXPLICIT_LOCAL_POSTGRES_REQUIRED');
const {default:pg}=await import(pathToFileURL(process.env.PADBOL_TEST_PG_MODULE).href);
export class PGlite{
 constructor(){this.pool=new pg.Pool({host:socket,port:55447,user:'padbol_support_test',database,max:3});this.ready=this.pool.connect().then(client=>this.client=client)}
 async exec(sql){await this.ready;return this.client.query(sql)}
 async query(sql,params){await this.ready;return this.client.query(sql,params)}
 async queryConcurrent(sql,params){return Promise.all([this.pool.query(sql,params),this.pool.query(sql,params)])}
 async close(){await this.ready;this.client.release();await this.pool.end()}
}
