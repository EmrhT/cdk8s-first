import { Construct } from 'constructs';
import { App, Chart, Size, Helm } from 'cdk8s';
import * as kplus from 'cdk8s-plus-27';


export class WebCacheDB extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);


    const storageNodes = kplus.Node.labeled(kplus.NodeLabelQuery.is('optimized', 'storage'));
    const memoryNodes = kplus.Node.labeled(kplus.NodeLabelQuery.is('optimized', 'memory'));

    const dbcpuResources: kplus.CpuResources = {
      limit: kplus.Cpu.millis(200),
      request: kplus.Cpu.millis(100)
    };

    const dbmemoryResources: kplus.MemoryResources = {
      limit: Size.mebibytes(100),
      request: Size.mebibytes(50),
    };

    const db = new kplus.StatefulSet(this, 'DB', {
      containers: [{ 
        image: 'woahbase/alpine-mysql:x86_64', 
        portNumber: 3306,
        resources: { 
          cpu: dbcpuResources,
          memory: dbmemoryResources
        },
        securityContext: {
          privileged: true,
          allowPrivilegeEscalation: true,
          ensureNonRoot: false,
          readOnlyRootFilesystem: false
        },
        liveness: kplus.Probe.fromTcpSocket(), // since this is not a working app, TCP probe is here. 
        readiness: kplus.Probe.fromTcpSocket() // On prod, /health and /ready must be queried.
      }],
      replicas: 2,
      spread: true,
      isolate: true,
    });
    db.scheduling.attract(storageNodes); // db sts will be affinited to storage nodes (node affinity)

    const cachecpuResources: kplus.CpuResources = {
      limit: kplus.Cpu.millis(200),
      request: kplus.Cpu.millis(100)
    };

    const cachememoryResources: kplus.MemoryResources = {
      limit: Size.mebibytes(100),
      request: Size.mebibytes(50),
    };

    const cache = new kplus.Deployment(this, 'Cache', {
      containers: [{
        image: 'redis:7.2.3-bookworm',
        portNumber: 6379,
        resources: { 
          cpu: cachecpuResources,
          memory: cachememoryResources
        },
        envVariables: {
          DB_HOST: kplus.EnvValue.fromValue(db.service.name),
          DB_PORT: kplus.EnvValue.fromValue(db.service.port.toString()),
        },
        securityContext: {
          privileged: true,
          allowPrivilegeEscalation: true,
          ensureNonRoot: false
        },
        liveness: kplus.Probe.fromTcpSocket(),
        readiness: kplus.Probe.fromTcpSocket()
      }],
      spread: true,
      isolate: true,
    });
    cache.scheduling.attract(memoryNodes); // cache deployment will be affinited to storage nodes (node affinity)

    const cacheService = cache.exposeViaService(); // by default exposes from the same port with container. here 7000:7000

    const webcpuResources: kplus.CpuResources = {
      limit: kplus.Cpu.millis(200),
      request: kplus.Cpu.millis(100)
    };

    const webmemoryResources: kplus.MemoryResources = {
      limit: Size.mebibytes(100),
      request: Size.mebibytes(50),
    };

    const web = new kplus.Deployment(this, 'Web', {
      automountServiceAccountToken: true, // this is required for services that consume other AWS resources with IRSA
      containers: [{
        image: 'hashicorp/http-echo',
        portNumber: 5678,
        resources: { 
          cpu: webcpuResources,
          memory: webmemoryResources
        },
        envVariables: {
          CACHE_HOST: kplus.EnvValue.fromValue(cacheService.name),
          CACHE_PORT: kplus.EnvValue.fromValue(cacheService.port.toString()),
        },
        securityContext: {  // privileged containers are bad practice and just here for demonstration
          privileged: true,
          allowPrivilegeEscalation: true,
          ensureNonRoot: false
        }, 
        liveness: kplus.Probe.fromTcpSocket(),
        readiness: kplus.Probe.fromTcpSocket()
      }],
      spread: true,
      isolate: true,
    });

    // TODO
    // secret and configmaps
    // 
    const deployments: any = [web, cache]; 


    for (let i = 0; i < deployments.length; i++) {
      new kplus.HorizontalPodAutoscaler(this, 'hpa-' + deployments[i].toString(), {
        target: deployments[i],
        maxReplicas: 100,
        minReplicas: 2,
        metrics: [kplus.Metric.resourceCpu(kplus.MetricTarget.averageUtilization(80))]
      });
    }

    const serviceWeb = web.exposeViaService({ serviceType: kplus.ServiceType.CLUSTER_IP });
    serviceWeb.exposeViaIngress('/*');


    web.scheduling.attract(memoryNodes);

    web.scheduling.colocate(cache, ); // translates into pod affinity

    web.connections.allowTo(cache); // creates netpol
    cache.connections.allowTo(db);

    const frontoffice = kplus.Group.fromName(this, 'FOGroup', 'frontoffice'); // create a K8S group named frontoffice

    web.permissions.grantReadWrite(frontoffice); // grant RW permissions to frontoffice group on web deployment object by creating required role&RB
    db.permissions.grantReadWrite(frontoffice);
    cache.permissions.grantReadWrite(frontoffice);




    new Helm(this, 'nginx', {
      namespace: 'test-app',
      chart: 'bitnami/nginx',
      values: {
        image: {
          repository: 'bitnami/nginx',
          tag: 'latest'
        },
        replicaCount: 2
      }
    });

  }

}

const app = new App();
new WebCacheDB(app, 'three-tier-web-app');
app.synth();