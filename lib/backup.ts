import { CfnCondition, CfnDeletionPolicy, Fn } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface BackupProps {
  /** Condition: EnableBackup = true. */
  readonly enabled: CfnCondition;
  /** BackupRetentionDays parameter. */
  readonly retentionDays: number;
}

/**
 * S3 bucket for ClickHouse native BACKUP/RESTORE. Versioned, encrypted, private, TLS-only; objects expire after
 * the retention period. The bucket is retained when the stack is deleted, so backups outlive the cluster.
 */
export function createBackupBucket(scope: Construct, props: BackupProps): s3.CfnBucket {
  const bucket = new s3.CfnBucket(scope, 'BackupBucket', {
    versioningConfiguration: { status: 'Enabled' },
    bucketEncryption: { serverSideEncryptionConfiguration: [{ serverSideEncryptionByDefault: { sseAlgorithm: 'AES256' } }] },
    publicAccessBlockConfiguration: {
      blockPublicAcls: true, blockPublicPolicy: true, ignorePublicAcls: true, restrictPublicBuckets: true,
    },
    ownershipControls: { rules: [{ objectOwnership: 'BucketOwnerEnforced' }] },
    lifecycleConfiguration: {
      rules: [{
        id: 'backup-retention',
        status: 'Enabled',
        expirationInDays: props.retentionDays,
        noncurrentVersionExpiration: { noncurrentDays: 7 },
        abortIncompleteMultipartUpload: { daysAfterInitiation: 7 },
      }],
    },
    tags: [{ key: 'Name', value: Fn.sub('${AWS::StackName}-clickhouse-backups') }],
  });
  bucket.cfnOptions.condition = props.enabled;
  bucket.cfnOptions.deletionPolicy = CfnDeletionPolicy.RETAIN;
  bucket.cfnOptions.updateReplacePolicy = CfnDeletionPolicy.RETAIN;

  const policy = new s3.CfnBucketPolicy(scope, 'BackupBucketPolicy', {
    bucket: bucket.ref,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{
        Sid: 'DenyInsecureTransport',
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:*',
        Resource: [bucket.attrArn, Fn.join('', [bucket.attrArn, '/*'])],
        Condition: { Bool: { 'aws:SecureTransport': 'false' } },
      }],
    },
  });
  policy.cfnOptions.condition = props.enabled;
  return bucket;
}
