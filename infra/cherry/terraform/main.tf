# Terraform example equivalent to infra/cherry/provision.sh: one bare-metal box in Chicago running
# infra/cherry/cloud-init.yaml (RAID0 /data, docker, repo, snapshot restore, compose stack).
#
#   cd infra/cherry/terraform
#   export CHERRY_API_KEY=...
#   cp terraform.tfvars.example terraform.tfvars   # project_id, repo_url, ...
#   terraform init && terraform plan && terraform apply

locals {
  bootstrap_env = join("\n", [
    "HOOD_REPO_URL='${var.repo_url}'",
    "HOOD_REPO_REF='${var.repo_ref}'",
    "HOOD_GIT_TOKEN='${var.git_token}'",
    "HOOD_DIR=/opt/hoodsniper",
    "",
  ])
  dotenv_b64 = var.dotenv_path == "" ? "" : filebase64(var.dotenv_path)
  # The template uses @@...@@ placeholders (not ${...}) so the embedded bash survives untouched.
  cloud_init = replace(
    replace(file("${path.module}/../cloud-init.yaml"), "@@HOOD_BOOTSTRAP_ENV_B64@@", base64encode(local.bootstrap_env)),
    "@@HOOD_DOTENV_B64@@", local.dotenv_b64
  )
}

resource "cherryservers_ssh_key" "operator" {
  name       = "hoodsniper-${var.hostname}"
  public_key = trimspace(file(pathexpand(var.ssh_public_key_path)))
}

resource "cherryservers_server" "hood" {
  project_id        = var.project_id
  plan              = var.plan
  region            = var.region
  image             = var.image
  hostname          = var.hostname
  cycle             = var.cycle
  os_partition_size = var.os_partition_size_gb
  ssh_key_ids       = [cherryservers_ssh_key.operator.id]
  user_data         = base64encode(local.cloud_init)
  spot_instance     = false
  tags = {
    app  = "hoodsniper"
    role = "chicago-node"
  }

  timeouts = {
    create = "90m"
  }

  lifecycle {
    # Changing user_data would re-install the box; cloud-init only matters on first boot anyway.
    ignore_changes = [user_data]
  }
}
