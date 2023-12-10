import { Construct } from 'constructs';
import { App, Chart, Size, Helm, Duration } from 'cdk8s';
import * as kplus from 'cdk8s-plus-27';
import { VirtualServer } from './imports/k8s.nginx.org';


export class WebCacheDB extends Chart {
  constructor(scope: Construct, ns: string) {
    super(scope, ns, {
      namespace: 'test-app',
      labels: {
        app: 'test-app'
      }
    });


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
        image: 'postgres:alpine3.19', 
        portNumber: 5432,
        resources: { 
          cpu: dbcpuResources,
          memory: dbmemoryResources
        },
        securityContext: { // privileged containers are bad practice and just here for demonstration
          privileged: true,
          allowPrivilegeEscalation: true,
          ensureNonRoot: false,
          readOnlyRootFilesystem: false
        },
        envVariables: {
          POSTGRES_PASSWORD: kplus.EnvValue.fromValue('password'),
        },
        liveness: kplus.Probe.fromCommand(['pg_isready', '-U', 'postgres', '-d', 'postgres'], {
          initialDelaySeconds: Duration.seconds(1),
          timeoutSeconds: Duration.seconds(5),
        }),
        readiness: kplus.Probe.fromCommand(['pg_isready', '-U', 'postgres', '-d', 'postgres'], {
          initialDelaySeconds: Duration.seconds(1),
          timeoutSeconds: Duration.seconds(5),
        }),
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
        liveness: kplus.Probe.fromTcpSocket(), // since this is not a working app, TCP probe is here. 
        readiness: kplus.Probe.fromTcpSocket() // On prod, /health and /ready must be queried.
      }],
      spread: true,
      isolate: true,
    });
    cache.scheduling.attract(memoryNodes); // cache deployment will be affinited to storage nodes (node affinity)

    const cacheService = cache.exposeViaService(); // by default exposes from the same port with container. here 7000:7000
    cacheService.metadata.addAnnotation('prometheus.io/scrape', 'true'); // dummy annotation for prometheus scraping

    const cacheConfigmap = new kplus.ConfigMap(this, 'CacheConfig'); // configmap with dummy appsettings.json file 
    cacheConfigmap.addFile('files/appsettings.json');
    const cacheVolume = kplus.Volume.fromConfigMap(this, 'Volume', cacheConfigmap);
    cache.containers[0].mount('/tmp', cacheVolume)

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
    const ingressWeb = new kplus.Ingress(web, 'WebIngress');
    
    ingressWeb.addRule('/', kplus.IngressBackend.fromService(serviceWeb)); // expose web outside to the cluster with ingress
    
    web.scheduling.attract(memoryNodes);
    web.scheduling.colocate(cache, ); // translates into pod affinity

    web.connections.allowTo(cache); // creates netpol
    cache.connections.allowTo(db);

    const frontoffice = kplus.Group.fromName(this, 'FOGroup', 'frontoffice'); // create a K8S group named frontoffice

    web.permissions.grantReadWrite(frontoffice); // grant RW permissions to frontoffice group on web deployment object by creating required role&RB
    db.permissions.grantReadWrite(frontoffice);
    cache.permissions.grantReadWrite(frontoffice);

    // secrets will be added by using External SO in a EKS cluster by using secret store and external secret CRDs

    const dummyVirtualServer= new VirtualServer(this, 'dummyVirtualServer', {  // created just for the sake of practice for importing and creating a CRD
      spec: {
        host: 'dummyhost.example.com',
        listener: {
          http: 'http-8043'
        },
        tls: {
          secret: 'dummy-secret'
        },
        gunzip: true,
        upstreams: [{
          name: 'test',
          service: 'test-service',
          port: 8000
        }],
        routes: [{
          path: '/test',
          action: {
            pass: 'test'
          }
        }]
      }
    });

    dummyVirtualServer.addDependency(web); // a dummy dependency for demo purposes

    new Helm(this, 'nginxHelm', {  // created just for the sake of practice for helm usage
      namespace: 'test-app',       // this method of directly downloading and using helm chartis practical but DOES NOT provide type safety
      chart: 'bitnami/nginx',      // which kills the most of the added value of using CDK8S and typescript
      values: {                    // instead, helm chart must be imported with "cdk8s import helm:https://charts.bitnami.com/bitnami/nginx"
        image: {                   
          repository: 'bitnami/nginx',
          tag: 'latest',
        },
        replicaCount: 2
      }
    });

  }

}

const app = new App();
new WebCacheDB(app, 'three-tier-web-app');
app.synth();