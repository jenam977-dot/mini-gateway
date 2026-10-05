#!/bin/bash
# OmniRoute AWS EC2 setup — t3.micro (1GB RAM) with swap
set -e

echo "=== 1. System info ==="
free -h
df -h / | tail -1

echo "=== 2. Adding 2GB swap (t3.micro has only 1GB RAM) ==="
if ! swapon --show | grep -q swapfile; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi
free -h | grep Swap

echo "=== 3. Installing Docker ==="
if ! command -v docker &> /dev/null; then
  sudo apt update -qq
  sudo apt install -y -qq docker.io docker-compose-plugin curl
  sudo systemctl enable --now docker
fi
docker --version
docker compose version

echo "=== 4. Downloading OmniRoute self-host files ==="
mkdir -p ~/omniroute && cd ~/omniroute
BASE=https://raw.githubusercontent.com/diegosouzapw/OmniRoute/v3.8.51
curl -fsSLO "$BASE/docker-compose.selfhost.yml"
curl -fsSLO "$BASE/.env.selfhost.example"
cp -n .env.selfhost.example .env 2>/dev/null || true
ls -la

echo "=== 5. Securing .env ==="
# REQUIRE_API_KEY=true, bind to loopback only
if grep -q "^REQUIRE_API_KEY=" .env; then
  sed -i 's/^REQUIRE_API_KEY=.*/REQUIRE_API_KEY=true/' .env
else
  echo 'REQUIRE_API_KEY=true' >> .env
fi
if grep -q "^APP_BIND_HOST=" .env; then
  sed -i 's/^APP_BIND_HOST=.*/APP_BIND_HOST=127.0.0.1/' .env
else
  echo 'APP_BIND_HOST=127.0.0.1' >> .env
fi
grep -E "^(REQUIRE_API_KEY|APP_BIND_HOST)=" .env

echo "=== 6. Starting OmniRoute ==="
sudo docker compose -f docker-compose.selfhost.yml up -d
sleep 10
sudo docker ps --format "table {{.Names}}\t{{.Status}}"

echo "=== 7. Waiting for health ==="
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:20128/healthz > /dev/null 2>&1; then
    echo "HEALTHY after ${i}0s"
    curl -s http://127.0.0.1:20128/healthz
    echo ""
    break
  fi
  echo "waiting... ($i)"
  sleep 10
done

echo "=== 8. Initial password (if any) ==="
sudo docker logs omniroute 2>&1 | grep -i "password" | head -3 || echo "no password in logs"

echo "=== DONE ==="
echo "Dashboard: use SSH tunnel -> http://localhost:20128"
echo "API: http://127.0.0.1:20128/v1"
