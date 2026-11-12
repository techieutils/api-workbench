import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { fileURLToPath } from 'node:url';

const definition = protoLoader.loadSync(
  fileURLToPath(new URL('./playground.proto', import.meta.url)),
  {
    defaults: true,
    oneofs: true,
  },
);
export const { EchoService } = grpc.loadPackageDefinition(definition).playground;
export { grpc };
