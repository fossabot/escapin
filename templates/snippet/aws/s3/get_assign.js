const $TEMPVAR = new S3().getObject({
  Bucket: $NAME,
  Key: $KEY,
});
$VAR = Buffer.from($TEMPVAR.Body).toString('utf8');
