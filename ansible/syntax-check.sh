#!/bin/sh
# ansible-playbook --syntax-check on every playbook, with an empty inventory in the runner's format (CI, ./labdeck lint).
set -eu
cd "$(dirname "$0")"
unset ANSIBLE_VAULT_PASSWORD_FILE ANSIBLE_INVENTORY # set in the runner containers; not needed here
inv=$(mktemp -d)/inventory.json
echo '{"all": {"children": {}}}' >"$inv"
for p in playbooks/*.yaml; do
  ANSIBLE_CONFIG=ansible.cfg ansible-playbook --syntax-check -i "$inv" -e target_hosts=all "$p"
done
rm -r "$(dirname "$inv")"
