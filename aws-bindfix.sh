#!/bin/bash
# Fix: bind OmniRoute to 0.0.0.0 so dashboard is reachable (API key still required)
set -e
cd /root/omniroute 2>/dev/null || cd ~/omniroute
sed -i 's/^APP_BIND_HOST=.*/APP_BIND_HOST=0.0.0.0/' .env
grep "^APP_BIND_HOST" .env
docker-compose down
docker-compose up -d
sleep 15
curl -s http://127.0.0.1:20128/healthz; echo ""
echo "Dashboard should now be reachable externally"
