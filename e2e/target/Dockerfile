# 假的實驗室主機（e2e 用）：Ubuntu 20.04 + systemd（PID 1）+ sshd + sudo，
# 有一個既有的共用管理帳號 admin（bootstrap 用）與兩個既有使用者 alice、bob（測試「未認領」帳號）。
# 需以 privileged、cgroup: host、掛 /sys/fs/cgroup、tmpfs /run /run/lock 執行（見 e2e/compose.e2e.yaml）。
FROM ubuntu:20.04
ENV DEBIAN_FRONTEND=noninteractive container=docker
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd systemd-sysv openssh-server sudo python3 pciutils ca-certificates curl ufw \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -s /bin/bash -G sudo admin && echo 'admin:adminpw' | chpasswd \
 && useradd -m -s /bin/bash -u 1001 alice \
 && useradd -m -s /bin/bash -u 1002 bob \
 && systemctl enable ssh \
 && rm -f /etc/ssh/ssh_host_*
# lspci 假裝 PCI 上有一張 NVIDIA 卡（沒有驅動、沒有 nvidia-smi）：GPU 看板只列有 GPU 的主機，
# 這台因此以「nvidia-smi 異常」列出（真正的故障情境），而不是被當成純 CPU 主機略過。其他 lspci 呼叫照常。
RUN printf '%s\n' '#!/bin/sh' 'case " $* " in *" -d 10de: "*) echo "01:00.0 0300: 10de:2204 (rev a1)"; exit 0 ;; esac' \
      'exec /usr/bin/lspci "$@"' > /usr/local/bin/lspci \
 && chmod 755 /usr/local/bin/lspci
# 每個容器開機時產生自己的 SSH host key（不把 key 燒進 image）
RUN printf '%s\n' '[Unit]' 'Before=ssh.service' '[Service]' 'Type=oneshot' 'ExecStart=/usr/bin/ssh-keygen -A' \
      '[Install]' 'WantedBy=multi-user.target' > /etc/systemd/system/ssh-hostkeys.service \
 && systemctl enable ssh-hostkeys
# 像實驗室的部分主機一樣開著 ufw（預設擋掉所有連入，只開 SSH）：「安裝監控」必須自己開 node_exporter 的 port，
# Prometheus 才抓得到（e2e 01 會等到 up=true）
RUN printf '%s\n' '[Unit]' 'After=network.target' 'Before=ssh.service' '[Service]' 'Type=oneshot' \
      "ExecStart=/bin/sh -c 'ufw allow 22/tcp && ufw --force enable'" '[Install]' 'WantedBy=multi-user.target' \
      > /etc/systemd/system/e2e-firewall.service \
 && systemctl enable e2e-firewall
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
