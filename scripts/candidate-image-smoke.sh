#!/usr/bin/env bash
# Only isolated synthetic CI resources; never accepts a deployment env file.
set -Eeuo pipefail
[[ ${CANDIDATE_ARCH:-} =~ ^(amd64|arm64)$ ]]
[[ ${GITHUB_RUN_ID:-} =~ ^[0-9]+$ && ${GITHUB_RUN_ATTEMPT:-} =~ ^[0-9]+$ ]]
test -n "${RUNNER_TEMP:-}"
[[ ${SUPPORT_SERVER_IMAGE:-} =~ ^sha256:[a-f0-9]{64}$ ]]
[[ ${SUPPORT_WEB_IMAGE:-} =~ ^sha256:[a-f0-9]{64}$ ]]
[[ ${SUPPORT_MCP_IMAGE:-} =~ ^sha256:[a-f0-9]{64}$ ]]
project="candidate-$CANDIDATE_ARCH-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
[[ ${#project} -le 63 && "$project" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]
migrate_container="$project-migrate"
umask 077
env_file="$RUNNER_TEMP/candidate-smoke.env"
config_file="$RUNNER_TEMP/candidate-smoke.config.json"
command_log="$RUNNER_TEMP/candidate-smoke.command.log"
compose=(docker compose --project-name "$project" --env-file "$env_file" -f deploy/support.compose.yaml -f deploy/support.config.compose.yaml -f deploy/support.mcp.compose.yaml -f deploy/smoke/support.mcp.smoke.compose.yaml --profile ui)
cleanup() {
  status=$?
  trap - EXIT
  # No logs/config/environment or synthetic action payloads are retained.
  if [[ -f "$env_file" ]]; then "${compose[@]}" down --volumes --remove-orphans > /dev/null 2>&1 || true; fi
  docker rm -f "$migrate_container" > /dev/null 2>&1 || true
  rm -f -- "$env_file" "$config_file" "$command_log"
  exit "$status"
}
trap cleanup EXIT
stage() {
  local name=$1
  shift
  if ! "$@" > "$command_log" 2>&1; then
    echo "Candidate stage failed: $name (raw fixture output is not retained)." >&2
    return 1
  fi
  echo "Candidate stage passed: $name"
}
: > "$env_file"
for name in POSTGRES_PASSWORD REDIS_PASSWORD API_TOKEN OPERATOR_TOKEN MCP_SERVICE_TOKEN MCP_UPSTREAM_TOKEN ORDERS_TEST_CONTROL_TOKEN; do
  value=$(openssl rand -hex 32)
  echo "::add-mask::$value"
  printf '%s=%s\n' "$name" "$value" >> "$env_file"
done
{
  printf 'PROJECT_NAME=%s\n' "$project"
  printf 'SUPPORT_SERVER_IMAGE=%s\nSUPPORT_WEB_IMAGE=%s\nSUPPORT_MCP_IMAGE=%s\n' "$SUPPORT_SERVER_IMAGE" "$SUPPORT_WEB_IMAGE" "$SUPPORT_MCP_IMAGE"
  printf 'MCP_UPSTREAM_BASE_URL=http://orders-mock:8090\nMCP_MANIFEST_PATH=../examples/orders/manifest.json\n'
  printf 'SUPPORT_CONFIG_PATH=%s\n' "$config_file"
} >> "$env_file"
stage config node scripts/mcp-sidecar-smoke.mjs prepare --out "$config_file" --url http://mcp-openapi:8000/mcp
chmod 644 "$config_file"
stage compose-validation "${compose[@]}" config --quiet
stage dependencies "${compose[@]}" up -d --no-build --wait --wait-timeout 180 postgres redis
stage migrations "${compose[@]}" run --name "$migrate_container" --no-deps migrate
stage startup "${compose[@]}" up -d --no-build --wait --wait-timeout 240 orders-mock fake-llm mcp-openapi api worker web
OPERATOR_TOKEN=$(sed -n 's/^OPERATOR_TOKEN=//p' "$env_file") \
ORDERS_TEST_CONTROL_TOKEN=$(sed -n 's/^ORDERS_TEST_CONTROL_TOKEN=//p' "$env_file") \
SMOKE_API_URL=http://127.0.0.1:18000 ORDERS_CONTROL_URL=http://127.0.0.1:18090 stage synthetic-dsh-mcp node scripts/mcp-sidecar-smoke.mjs run
stage frontend "${compose[@]}" exec -T -e SMOKE_BASE_URL=http://web:8080 -e SMOKE_HOST=localhost api node --input-type=module - < scripts/frontend-smoke.mjs
python3 - "$env_file" "$project" "$CANDIDATE_ARCH" <<'PY'
import json,pathlib,subprocess,sys
args=['docker','compose','--project-name',sys.argv[2],'--env-file',sys.argv[1],'-f','deploy/support.compose.yaml','-f','deploy/support.config.compose.yaml','-f','deploy/support.mcp.compose.yaml','-f','deploy/smoke/support.mcp.smoke.compose.yaml','--profile','ui','ps','--format','json']
result=subprocess.run(args,capture_output=True,text=True,timeout=20,check=True)
if len(result.stdout)>100_000: raise SystemExit('Container status exceeds evidence limit')
raw=result.stdout.strip()
containers=json.loads(raw) if raw.startswith('[') else [json.loads(line) for line in raw.splitlines()]
states={entry['Service']:{'state':entry['State'],'health':entry.get('Health','')} for entry in containers}
required={'postgres','redis','orders-mock','fake-llm','mcp-openapi','api','worker','web'}
if set(states)!=required or any(item!={'state':'running','health':'healthy'} for item in states.values()): raise SystemExit('Candidate container health is incomplete')
graph_roles={'api':'server','worker':'server','migrate':'server','web':'web','mcp-openapi':'mcp'}
containers.append({'Service':'migrate','ID':sys.argv[2]+'-migrate'})
bindings={}
for entry in containers:
    role=graph_roles.get(entry['Service'])
    if role is None: continue
    graph=json.loads(pathlib.Path('candidate-evidence/'+role+'-oci.json').read_text())
    inspected=subprocess.run(['docker','container','inspect',entry['ID']],capture_output=True,text=True,timeout=20,check=True)
    if len(inspected.stdout)>100_000: raise SystemExit('Container inspection exceeds bound')
    actual=json.loads(inspected.stdout)[0]
    if entry['Service']=='migrate' and (actual.get('State',{}).get('Status')!='exited' or actual.get('State',{}).get('ExitCode')!=0): raise SystemExit('Migration container did not finish successfully')
    allowed={graph['imageIndexDigest'],graph['platformManifestDigest'],graph['configDigest']}
    if actual.get('Image') not in allowed or graph['platform']!='linux/'+sys.argv[3] or actual.get('Config',{}).get('Image')!=graph['runtimeImageId']: raise SystemExit('Started container image does not match verified OCI binding')
    bindings[entry['Service']]={'imageId':actual['Image'],'requestedRuntimeId':graph['runtimeImageId'],'platform':graph['platform']}
if set(bindings)!=set(graph_roles): raise SystemExit('Missing product runtime image binding')
pathlib.Path('candidate-evidence/smoke.json').write_text(json.dumps({'schemaVersion':1,'mode':'native-source-build-synthetic','checks':{'dshMcpOrders':True,'worker':True,'web':True},'services':states,'ociRuntimeBindings':bindings},sort_keys=True,indent=2)+'\n')
PY
