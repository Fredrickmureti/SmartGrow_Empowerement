# AccrualFlow Kubernetes Deployment Guide

This guide covers deploying AccrualFlow to Kubernetes clusters.

## Prerequisites

- **kubectl** configured with cluster access
- **kustomize** (built into kubectl 1.14+)
- Docker registry access for images
- (Optional) **cert-manager** for TLS certificates
- (Optional) **nginx-ingress** controller

## Quick Start

### 1. Build and Push Docker Image

```bash
# Build the production image
docker build -t your-registry.com/accrualflow:latest .

# Push to registry
docker push your-registry.com/accrualflow:latest
```

### 2. Create Secrets

```bash
# Create namespace first
kubectl apply -f k8s/base/namespace.yaml

# Create secrets (replace with actual values!)
kubectl create secret generic accrualflow-secrets \
  --from-literal=SUPABASE_URL=https://your-project.supabase.co \
  --from-literal=SUPABASE_ANON_KEY=eyJyour-anon-key \
  --from-literal=SENTRY_DSN=https://your-sentry-dsn \
  -n accrualflow
```

### 3. Deploy

```bash
# Development environment
kubectl apply -k k8s/overlays/development

# Production environment
kubectl apply -k k8s/overlays/production
```

### 4. Verify Deployment

```bash
# Check pods
kubectl get pods -n accrualflow

# Check service
kubectl get svc -n accrualflow

# Check ingress
kubectl get ingress -n accrualflow

# View logs
kubectl logs -l app.kubernetes.io/name=accrualflow -n accrualflow
```

## Directory Structure

```
k8s/
├── base/                    # Base resources
│   ├── namespace.yaml       # Namespace definition
│   ├── configmap.yaml       # Non-secret configuration
│   ├── secret.yaml          # Secret template (don't commit values!)
│   ├── deployment.yaml      # Application deployment
│   ├── service.yaml         # ClusterIP service
│   ├── ingress.yaml         # Ingress with TLS
│   └── kustomization.yaml   # Base kustomization
│
├── overlays/
│   ├── development/         # Dev environment overrides
│   │   └── kustomization.yaml
│   │
│   └── production/          # Prod environment overrides
│       ├── kustomization.yaml
│       ├── hpa.yaml         # Horizontal Pod Autoscaler
│       └── pdb.yaml         # Pod Disruption Budget
│
└── README.md                # This file
```

## Environment Configuration

### Development

- Single replica
- Reduced resource limits
- NodePort service for local access (port 30080)
- Analytics disabled

```bash
kubectl apply -k k8s/overlays/development
# Access at: http://<node-ip>:30080
```

### Production

- 3 replicas (scales 2-10 with HPA)
- Higher resource limits
- Ingress with TLS
- Pod Disruption Budget for HA
- Full analytics enabled

```bash
kubectl apply -k k8s/overlays/production
# Access at: https://app.accrualflow.com
```

## Customization

### Change Image Registry

Edit `k8s/overlays/production/kustomization.yaml`:

```yaml
images:
  - name: accrualflow
    newName: your-registry.com/accrualflow
    newTag: v1.2.3
```

### Change Domain

Edit the ingress patch in `k8s/overlays/production/kustomization.yaml`:

```yaml
patches:
  - target:
      kind: Ingress
      name: accrualflow-ingress
    patch: |-
      - op: replace
        path: /spec/rules/0/host
        value: your-domain.com
```

### Adjust Scaling

Edit `k8s/overlays/production/hpa.yaml`:

```yaml
spec:
  minReplicas: 3    # Minimum pods
  maxReplicas: 20   # Maximum pods
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 60  # Scale earlier
```

## TLS Configuration

### Using cert-manager (Recommended)

1. Install cert-manager:
   ```bash
   kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.13.0/cert-manager.yaml
   ```

2. Create ClusterIssuer:
   ```yaml
   apiVersion: cert-manager.io/v1
   kind: ClusterIssuer
   metadata:
     name: letsencrypt-prod
   spec:
     acme:
       server: https://acme-v02.api.letsencrypt.org/directory
       email: your-email@example.com
       privateKeySecretRef:
         name: letsencrypt-prod
       solvers:
         - http01:
             ingress:
               class: nginx
   ```

3. Deploy - certificates are automatically provisioned

### Manual TLS

Create a TLS secret manually:

```bash
kubectl create secret tls accrualflow-tls \
  --cert=path/to/tls.crt \
  --key=path/to/tls.key \
  -n accrualflow
```

## Monitoring

### View Pod Status

```bash
kubectl get pods -n accrualflow -w
```

### View HPA Status

```bash
kubectl get hpa -n accrualflow
```

### View Resource Usage

```bash
kubectl top pods -n accrualflow
```

### View Logs

```bash
# All pods
kubectl logs -l app.kubernetes.io/name=accrualflow -n accrualflow

# Specific pod
kubectl logs accrualflow-web-xxxxx -n accrualflow

# Follow logs
kubectl logs -f -l app.kubernetes.io/name=accrualflow -n accrualflow
```

## Troubleshooting

### Pods not starting

```bash
# Check pod events
kubectl describe pod <pod-name> -n accrualflow

# Common issues:
# - ImagePullBackOff: Check registry credentials
# - CrashLoopBackOff: Check container logs
# - Pending: Check resource quotas
```

### Health check failing

```bash
# Test health endpoint
kubectl exec -it <pod-name> -n accrualflow -- curl http://localhost/health
```

### Ingress not working

```bash
# Check ingress controller
kubectl get pods -n ingress-nginx

# Check ingress status
kubectl describe ingress accrualflow-ingress -n accrualflow
```

### Scale manually

```bash
# Scale up
kubectl scale deployment accrualflow-web --replicas=5 -n accrualflow

# Scale down
kubectl scale deployment accrualflow-web --replicas=2 -n accrualflow
```

## Rollback

```bash
# View rollout history
kubectl rollout history deployment/accrualflow-web -n accrualflow

# Rollback to previous version
kubectl rollout undo deployment/accrualflow-web -n accrualflow

# Rollback to specific revision
kubectl rollout undo deployment/accrualflow-web --to-revision=2 -n accrualflow
```

## Cleanup

```bash
# Delete development
kubectl delete -k k8s/overlays/development

# Delete production
kubectl delete -k k8s/overlays/production

# Delete namespace (removes everything)
kubectl delete namespace accrualflow
```

## CI/CD Integration

Example GitHub Actions workflow:

```yaml
name: Deploy to Kubernetes

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Build and push image
        run: |
          docker build -t ${{ secrets.REGISTRY }}/accrualflow:${{ github.sha }} .
          docker push ${{ secrets.REGISTRY }}/accrualflow:${{ github.sha }}
      
      - name: Deploy to Kubernetes
        run: |
          kubectl set image deployment/accrualflow-web \
            web=${{ secrets.REGISTRY }}/accrualflow:${{ github.sha }} \
            -n accrualflow
```

---

For more information, see the main [ARCHITECTURE.md](../docs/ARCHITECTURE.md) documentation.
