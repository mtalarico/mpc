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

interface Configuration {
  is_atlas: boolean;
  fixed: boolean;
  slowms: number;
  level: number;
  duration: number;
  mongodb_uri: string;
  db_name: string;
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
  --fixed\t\tdo not wait and restore, change the profiler to a fixed value and exit\n\
  --db\t\t\tchange the profiler settings on a different database\n\
  --slowms\t\tthe desired slowms threshold to change the profiler to\n\
  --level\t\tthe desired level to change the profiler to (levels other than 0 can signficiantly degrade performance)\n\
\natlas settings:\n\
  --atlas_project_id\tthe project ID the cluster is in [ATLAS_PROJECT_ID]\n\
  --atlas_public_key\tpublic key of API key to request dynamic slowms to be toggled [ATLAS_PUBLIC_KEY]\n\
  --atlas_private_key\tpublic key of API key to request dynamic slowms to be toggled [ATLAS_PRIVATE_KEY]\n\
  --help\t\tprint this menu and exit\n\
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
    boolean: ["help", "fixed"],
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
    flags.atlas_public_key || Deno.env.get("ATLAS_PUBLIC_KEY");
  const atlas_private_key =
    flags.atlas_private_key || Deno.env.get("ATLAS_PRIVATE_KEY");
  const atlas_project_id =
    flags.atlas_project_id || Deno.env.get("ATLAS_PROJECT_ID");

  const config = {
    fixed: flags.fixed,
    slowms: flags.slowms,
    level: flags.level,
    duration: flags.t,
    db_name: flags.db,
    mongodb_uri,
    atlas_public_key,
    atlas_private_key,
    atlas_project_id,
  } as Configuration;

  config.is_atlas = validate_input(config);
  // print_config(config);
  log(`using configuration:\n${JSON.stringify(config, redact_config, "  ")}, `);
  return config;
}

interface Clients {
  mongo: MongoClient;
  http?: DigestClient;
  groupId?: string;
}

// validate potential env -- note since we wrapped in ), null will equal "undefine"
function validate_input(c: Configuration): boolean {
  if (!c.mongodb_uri) {
    log("must provide uri for mongodb");
    Deno.exit(1);
  }
  if (!c.fixed && !c.duration) {
    log(
      "must provide time in minutes to sleep for before restoring profiler or --fixed to change once"
    );
    Deno.exit(1);
  }
  if (c.atlas_public_key && c.atlas_private_key && c.atlas_project_id) {
    return true;
  } else if (
    !c.atlas_public_key &&
    !c.atlas_private_key &&
    !c.atlas_project_id
  ) {
    if (c.mongodb_uri.includes(".mongodb.net")) {
      log(
        "it looks like this is an atlas cluster, but no atlas credentials were provided, consider doing so to disable the dynamic slowms threshold, else profiling logs may be unreliable"
      );
    }
    return false;
  } else {
    log("must set public key, private key and project ID to use atlas");
    Deno.exit(1);
  }
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

async function profile_for_period() {
  const old = await get_profiling_level();

  Deno.addSignalListener("SIGINT", async function () {
    log("");
    await set_profiling_level(old);
    await set_atlas_dynamic_slowms(true);
    Deno.exit(1);
  });

  try {
    await set_atlas_dynamic_slowms(false);
    await set_profiling_level({
      profile: config.level,
      slowms: config.slowms,
      sample: new Double(1.0),
      filter: "unset",
    });
    if (config.fixed) {
      Deno.exit(0);
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
await profile_for_period();
Deno.exit(0);
