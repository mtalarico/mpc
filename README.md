# mpc

a small script intended for Deno to better control the MongoDB database profiler.

```
deno run --allow-all mpc.ts --help
MongoDB Profiler Controller (mpc)
--
example usage:  deno --allow-all run --uri 'mongodb://localhost:27017' --t 5 <options>

options that have [EXAMPLE] will be read via environment variables if the CLI equivalent is ommited

required :
  --uri                 mongodb connection string [MONGODB_URI]
  --t                   time in MINUTES to sleep before restoring the profiler to its original settings

optional:
  --fixed               do not wait and restore, change the profiler to a fixed value and exit
  --db                  change the profiler settings on a different database
  --slowms              the desired slowms threshold to change the profiler to
  --level               the desired level to change the profiler to (levels other than 0 can degrade performance)
  --reset               change settings back to defaults (100ms slow, unset filter, dynamic ms threshold ON for Atlas), all other parameters will be ignored

atlas settings:
  --atlas_project_id    the project ID the cluster is in [MONGODB_ATLAS_PROJECT_ID]
  --atlas_public_key    public key of API key to request dynamic slowms to be toggled [MONGODB_ATLAS_PUBLIC_KEY]
  --atlas_private_key   public key of API key to request dynamic slowms to be toggled [MONGODB_ATLAS_PRIVATE_KEY]

note: sending SIGINT during sleep will still attempt to restore the profiler back to its original value
```