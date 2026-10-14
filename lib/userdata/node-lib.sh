# ---- node-lib.sh: helpers shared by the boot scripts and the day-2 node-config association ----
# Part of the boot user data and embedded in the node-config SSM document, so running nodes always use the
# version of the stack's current template (the launch template, pinned at version 1, never changes for them).
# Needs log(), CH_VERSION and ARCH (aarch64 | x86_64).

# Install pinned ClickHouse packages: official RPM repo first, GitHub release RPMs as fallback.
install_clickhouse_packages() {
  local pkgs=("$@") with_ver=() p
  for p in "${pkgs[@]}"; do with_ver+=("$p-$CH_VERSION"); done
  curl -fsSL https://packages.clickhouse.com/rpm/clickhouse.repo -o /etc/yum.repos.d/clickhouse.repo || true
  # enable the LTS channel too, so both -stable and -lts versions resolve
  sed -i 's/^enabled=0/enabled=1/' /etc/yum.repos.d/clickhouse.repo 2>/dev/null || true
  log "installing ${with_ver[*]} from packages.clickhouse.com"
  if dnf install -y -q "${with_ver[@]}"; then return 0; fi

  log "repo install failed, falling back to GitHub release RPMs"
  local tmp=/tmp/ch-rpms suffix url ok rpms=("${pkgs[@]}")
  # clickhouse-server/client depend on clickhouse-common-static; clickhouse-keeper is standalone
  [[ " ${pkgs[*]} " == *" clickhouse-server "* ]] && [[ " ${pkgs[*]} " != *" clickhouse-common-static "* ]] && rpms=(clickhouse-common-static "${pkgs[@]}")
  mkdir -p "$tmp"
  for suffix in lts stable; do
    ok=1
    rm -f "$tmp"/*.rpm
    for p in "${rpms[@]}"; do
      url="https://github.com/ClickHouse/ClickHouse/releases/download/v${CH_VERSION}-${suffix}/${p}-${CH_VERSION}.${ARCH}.rpm"
      curl -fsSL --retry 5 -o "$tmp/${p}.rpm" "$url" || { ok=0; break; }
    done
    [ "$ok" = 1 ] && break
  done
  [ "$ok" = 1 ] || { log "ClickHouse $CH_VERSION not found in repo nor GitHub releases"; return 1; }
  dnf install -y -q "$tmp"/*.rpm
}

# systemd drop-ins: clickhouse-server / clickhouse-keeper only start once the data volume is mounted on
# /var/lib/clickhouse (the fstab entry is nofail, so a missing volume must not let them start on the root disk).
# Prints the drop-in paths that changed; the caller runs systemctl daemon-reload when needed.
install_data_volume_dropins() {
  local svc f
  for svc in clickhouse-server clickhouse-keeper; do
    f=/etc/systemd/system/$svc.service.d/data-volume.conf
    if [ ! -f "$f" ] || [ "$(cat "$f")" != $'[Unit]\nRequiresMountsFor=/var/lib/clickhouse' ]; then
      mkdir -p "${f%/*}"
      printf '[Unit]\nRequiresMountsFor=/var/lib/clickhouse\n' > "$f"
      echo "$f"
    fi
  done
}
