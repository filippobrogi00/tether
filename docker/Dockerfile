FROM centos:7
RUN sed -i 's|^mirrorlist=|#mirrorlist=|; s|^#baseurl=http://mirror.centos.org|baseurl=http://vault.centos.org|' /etc/yum.repos.d/CentOS-*.repo \
 && yum install -y openssh-server passwd findutils which \
 && yum clean all \
 && ssh-keygen -A \
 && useradd -m test && echo 'test:test' | chpasswd
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]