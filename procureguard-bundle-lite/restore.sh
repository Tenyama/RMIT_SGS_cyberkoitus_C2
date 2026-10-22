#!/usr/bin/env bash
# Restore ProcureGuard TideCloak from the 6 MB DB file (base image pulled from Docker Hub, pinned by digest).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
IMG="tideorg/tidecloak-dev@sha256:3f52d0bc3e4e3ae5153e172960003bbe94705cd40af6561fd4c7c4434aaa2708"
docker pull "$IMG"
docker rm -f procureguard-tidecloak >/dev/null 2>&1 || true
docker create --name procureguard-tidecloak --restart unless-stopped -p 8080:8080 -p 9000:9000 \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin -e KC_HEALTH_ENABLED=true -e KC_METRICS_ENABLED=true "$IMG" >/dev/null
docker cp "$HERE/h2/." procureguard-tidecloak:/opt/keycloak/data/h2/
docker start procureguard-tidecloak >/dev/null
for i in $(seq 60); do curl -s -m3 localhost:8080/realms/master/protocol/openid-connect/token -d grant_type=password -d client_id=admin-cli -d username=admin -d password=admin | grep -q access_token && break; sleep 3; done
echo "TideCloak ready: http://localhost:8080/admin/master/console/#/test1  (admin/admin)"
echo "Then: cp $HERE/procureguard.env <repo>/.env  and follow README Setup B"
