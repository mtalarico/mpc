import { DigestClient } from "https://deno.land/x/digest_fetch@v1.2.1/mod.ts";
import { sleep } from "https://deno.land/x/sleep@v1.2.1/mod.ts";
import { parse } from "https://deno.land/std@0.194.0/flags/mod.ts";
import { Document, Double, MongoClient } from "npm:mongodb@5.7";

interface ProfilerSettings {
  profile: number;
  slowms: number;
  sampleRate?: Double;
  filter?: Document;
}

interface ValidationResult {
  is_atlas: boolean;
  error: string;
}

interface Configuration {
  is_atlas: boolean;
  fixed: boolean;
  slowms: number;
  level: number;
  duration: number;
  mongodb_uri: string;
  db_name: string;
  reset?: boolean;
  atlas_public_key?: string;
  atlas_private_key?: string;
  atlas_project_id?: string;
}

function print_help_and_exit() {
  console.log(
    "MongoDB Profiler Controller (mpc)\n\
--\n\
example usage:\tdeno --allow-all run --uri 'mongodb://localhost:27017' --t 5 <options>\n\
\n\
options that have [EXAMPLE] will be read via environment variables if the CLI equivalent is ommited\n\
\nrequired :\n\
  --uri\t\t\tmongodb connection string [MONGODB_URI]\n\
  --t\t\t\ttime in MINUTES to sleep before restoring the profiler to its original settings\n\
\noptional:\n\
  --fixed\t\tdo not wait t time before restoring settings, just set desired settings and exit\n\
  --db\t\t\tchange the profiler settings on a different database (defaults to admin)\n\
  --slowms\t\tthe desired slowms threshold to change the profiler to\n\
  --level\t\tthe desired level to change the profiler to (levels other than 0 can degrade performance)\n\
  --reset\t\tchange settings back to defaults (100ms slow, unset filter, dynamic ms threshold ON for Atlas), all other parameters will be ignored\n\
\natlas settings:\n\
  --atlas_project_id\tthe project ID the cluster is in [MONGODB_ATLAS_PROJECT_ID]\n\
  --atlas_public_key\tpublic key of API key to request dynamic slowms to be toggled [MONGODB_ATLAS_PUBLIC_KEY]\n\
  --atlas_private_key\tpublic key of API key to request dynamic slowms to be toggled [MONGODB_ATLAS_PRIVATE_KEY]\n\
\n\
note: sending SIGINT during sleep will still attempt to restore the profiler back to its original value\
"
  );
  Deno.exit(0);
}

function log(message: string) {
  console.log(`[${new Date().toISOString()}] ` + message);
}

function redact_config(k: string, v: any) {
  if (!v) {
    return;
  }
  if (k == "mongodb_uri") {
    return v.replace(/(?!:\/\/)(:(.*)@)/, ":xxx@");
  }
  if (k == "atlas_private_key" && v) {
    return "xxx";
  }
  return v;
}

function configure(): Configuration {
  const flags = parse(Deno.args, {
    boolean: ["help", "fixed", "reset"],
    string: [
      "uri",
      "atlas_project_id",
      "atlas_public_key",
      "atlas_private_key",
      "db",
    ],
    default: {
      fixed: false,
      slowms: 0,
      level: 0,
      db: "admin",
    },
  });

  if (flags.help) {
    print_help_and_exit();
  }

  // the following can be provided either from the CLI or falls back to env
  const mongodb_uri = flags.uri || Deno.env.get("MONGODB_URI");
  const atlas_public_key =
    flags.atlas_public_key || Deno.env.get("MONGODB_ATLAS_PUBLIC_KEY");
  const atlas_private_key =
    flags.atlas_private_key || Deno.env.get("MONGODB_ATLAS_PRIVATE_KEY");
  const atlas_project_id =
    flags.atlas_project_id || Deno.env.get("MONGODB_ATLAS_PROJECT_ID");

  const config = {
    fixed: flags.fixed,
    slowms: flags.slowms,
    level: flags.level,
    duration: flags.t,
    db_name: flags.db,
    reset: flags.reset,
    mongodb_uri,
    atlas_public_key,
    atlas_private_key,
    atlas_project_id,
  } as Configuration;

  const res = validate_input(config);
  if (res.error != "") {
    log(res.error);
    Deno.exit(1);
  }
  config.is_atlas = res.is_atlas;
  // print_config(config);
  log(`using configuration:\n${JSON.stringify(config, redact_config, "  ")}, `);
  return config;
}

interface Clients {
  mongo: MongoClient;
  http?: DigestClient;
  groupId?: string;
}

// validate potential env -- note since we wrapped in ), null will equal "undefined"
function validate_input(c: Configuration): ValidationResult {
  const result: ValidationResult = { is_atlas: false, error: "" };
  if (!c.mongodb_uri) {
    result.error = "must provide uri for mongodb";
    return result;
  }
  if (c.atlas_public_key && c.atlas_private_key && c.atlas_project_id) {
    result.is_atlas = true;
  } else if (c.mongodb_uri.includes(".mongodb.net")) {
    result.error =
      "this looks like an Atlas cluster, but not all Atlas credentials (public + private key, projectId) were provided";
    return result;
  }
  if (!c.reset && !c.fixed && !c.duration) {
    result.error =
      "must provide time in minutes to sleep for before restoring profiler or --fixed to change once";
    return result;
  }
  return result;
}

async function init(): Promise<Clients> {
  const clients = {} as Clients;
  try {
    clients.mongo = await new MongoClient(config.mongodb_uri).connect();
    if (config.is_atlas) {
      clients.http = new DigestClient(
        config.atlas_public_key || "",
        config.atlas_private_key || ""
      );
      clients.groupId = config.atlas_project_id;
    }
    return clients;
  } catch (error) {
    log(`unable to generate clients: ${error}`);
    Deno.exit(1);
  }
}

async function set_atlas_dynamic_slowms(enable: boolean) {
  if (!config.is_atlas) {
    return;
  }
  let action, verb: string;
  if (enable) {
    action = "POST";
    verb = "enable";
    log("enabling atlas dynamic slowms");
  } else {
    action = "DELETE";
    verb = "disable";
    log("disabling atlas dynamic slowms");
  }
  const uri = `https://cloud.mongodb.com/api/atlas/v2/groups/${clients.groupId}/managedSlowMs/${verb}`;
  const resp = await clients.http?.fetch(uri, {
    method: action,
    headers: {
      Accept: "application/vnd.atlas.2023-02-01+json",
    },
  });
  if (resp?.status != 204) {
    log(`error: ${JSON.stringify(await resp?.json())}`);
    Deno.exit(1);
  }
}

async function get_profiling_level(): Promise<ProfilerSettings> {
  const raw = await clients.mongo.db(config.db_name).command({ profile: -1 });
  const current = {
    profile: raw.was,
    slowms: raw.slowms,
  } as ProfilerSettings;
  if (raw.sampleRate) {
    current.sampleRate = new Double(raw.sampleRate);
  }
  if (raw.filter) {
    current.filter = raw.filter;
  }
  log(`profile level is ${JSON.stringify(current)}`);
  return current;
}

async function set_profiling_level(change: Document) {
  await clients.mongo.db(config.db_name).command(change);
  log(`set profiler to ${JSON.stringify(change)} on db '${config.db_name}'`);
}

async function run() {
  const old = await get_profiling_level();

  Deno.addSignalListener("SIGINT", async function () {
    log("");
    await set_profiling_level(old);
    await set_atlas_dynamic_slowms(true);
    Deno.exit(1);
  });

  if (config.reset) {
    await set_profiling_level({
      profile: 0,
      slowms: 100,
      sampleRate: new Double(1.0),
      filter: "unset",
    });
    await set_atlas_dynamic_slowms(true);
    return;
  }

  try {
    await set_atlas_dynamic_slowms(false);
    await set_profiling_level({
      profile: config.level,
      slowms: config.slowms,
      sampleRate: new Double(1.0),
      filter: "unset",
    });
    if (config.fixed) {
      return;
    }
    const end = new Date(new Date().getTime() + config.duration * 60000);
    log(
      `sleeping for ${
        config.duration
      } minute(s) (wake at: ${end.toISOString()})`
    );
    await sleep(config.duration * 60);
  } finally {
    await set_profiling_level(old);
    await set_atlas_dynamic_slowms(true);
  }
}

const config = configure();
const clients = await init();
await run();
Deno.exit(0);
