/** The exact packaged worker runs behind loopback-only forwards to this
 * checkout's Docker services. No host-network dependency on macOS/Windows. */
import { readFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { spawn } from "node:child_process";

async function main(){
 const [projectId,command="run"]=process.argv.slice(2);
 if(!/^embel-dev-[a-f0-9]{12}$/.test(projectId??"")||!["run","preflight"].includes(command))throw Error("invalid_development_runtime_arguments");
 const configuration=JSON.parse(await readFile("/run/embel/configuration.json","utf8"));
 const secrets=await readFile("/run/embel/secrets.json","utf8");
 const target=configuration.target;
 if(target?.kind!=="development"||target.databaseHost!=="127.0.0.1"||!/^http:\/\/127\.0\.0\.1:\d+$/.test(target.supabaseOrigin??""))throw Error("invalid_development_target");
 const apiPort=Number(new URL(target.supabaseOrigin).port),dbPort=target.databasePort;
 if(![apiPort,dbPort].every(port=>Number.isInteger(port)&&port>=1024&&port<=65535)||apiPort===dbPort)throw Error("invalid_development_ports");
 const sockets=new Set(),servers=[];
 for(const [localPort,host,port] of [[apiPort,`supabase_kong_${projectId}`,8000],[dbPort,`supabase_db_${projectId}`,5432]]){
  const server=createServer(client=>{
   const upstream=connect({host,port});sockets.add(client);sockets.add(upstream);
   client.on("error",()=>upstream.destroy());upstream.on("error",()=>client.destroy());
   client.on("close",()=>{sockets.delete(client);upstream.destroy();});upstream.on("close",()=>{sockets.delete(upstream);client.destroy();});
   client.pipe(upstream);upstream.pipe(client);
  });
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(localPort,"127.0.0.1",resolve);});servers.push(server);
 }
 const env={...process.env,NODE_ENV:"development",EMBEL_DEVELOPMENT_ENABLED:"true",APP_ORIGIN:target.applicationOrigin,NEXT_PUBLIC_SUPABASE_URL:target.supabaseOrigin,
  EMBEL_SHARED_WORKER_POOL_ENABLED:"true",EMBEL_SHARED_WORKER_POOL_CONFIGURATION:JSON.stringify(configuration),EMBEL_SHARED_WORKER_POOL_SECRETS:secrets,
  EMBEL_DEVELOPMENT_QUEUE_DIRECTORY:"/var/lib/embel/queue"};
 delete env.OPENAI_API_KEY;
 // Only bootstrap needs root to read the host's mode-0600 credential files.
 if(process.getuid?.()===0){process.setgid(1000);process.setuid(1000);}
 const child=spawn(process.execPath,["dist/index.js",...(command==="preflight"?["--preflight"]:[])],{env,stdio:"inherit"});
 const stop=signal=>child.kill(signal);process.on("SIGTERM",stop);process.on("SIGINT",stop);
 const code=await new Promise(resolve=>{child.once("error",()=>resolve(2));child.once("exit",value=>resolve(value??2));});
 for(const socket of sockets)socket.destroy();await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));
 process.exitCode=code;
}
main().catch(()=>{process.stderr.write('{"event":"development_shared_worker_unavailable"}\n');process.exit(2);});
