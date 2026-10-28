output "server_id" {
  value = cherryservers_server.hood.id
}

output "public_ipv4" {
  value = one([for ip in cherryservers_server.hood.ip_addresses : ip.address if ip.address_family == 4 && ip.type == "primary-ip"])
}

output "next_steps" {
  value = "ssh root@<public_ipv4> 'tail -f /var/log/cloud-init-output.log' - then docs/RUNBOOK.md step 2"
}
