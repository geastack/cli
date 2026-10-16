"""Gea Linux transaction transport. Runs only over explicitly pinned SSH.
A reviewed, hash-pinned Python hook/profile is streamed with the release; no
preinstalled new hook, shell command interpolation or product-specific policy.
The hook owns service/session/storage authority. Transport never calls reboot,
changes a unit, selects a release or claims protection from command exit alone.
"""
import base64, hashlib, json, os, signal, stat, subprocess, sys

def sha(data): return hashlib.sha256(data).hexdigest()
def check(ok, reason):
    if not ok: raise RuntimeError(reason)
def private_dir(path, create=False):
    check(os.path.isabs(path) and os.path.realpath(path)==path, 'noncanonical directory')
    parent=os.path.dirname(path)
    while True:
        ancestor=os.lstat(parent)
        check(stat.S_ISDIR(ancestor.st_mode) and (ancestor.st_mode&0o022==0 or ancestor.st_mode&stat.S_ISVTX),'replaceable transaction ancestor')
        if parent=='/': break
        parent=os.path.dirname(parent)
    if create:
        try: os.mkdir(path, 0o700)
        except FileExistsError: pass
    s=os.lstat(path)
    check(stat.S_ISDIR(s.st_mode) and s.st_uid==os.getuid() and s.st_mode&0o077==0, 'unsafe transaction directory')
def sync_dir(path):
    fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)
def write(path,data,mode):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
    try:
        os.fchmod(fd,mode)
        with os.fdopen(fd,'wb',closefd=False) as stream:
            stream.write(data);stream.flush();os.fsync(fd)
    finally: os.close(fd)
def save(path,state):
    tmp=path+'.new'
    write(tmp,json.dumps(state,sort_keys=True).encode(),0o600)
    os.replace(tmp,path);sync_dir(os.path.dirname(path))
def regular(path, expected=None):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        st=os.fstat(fd);check(stat.S_ISREG(st.st_mode) and st.st_uid==os.getuid() and st.st_mode&0o022==0,'unsafe staged file')
        with os.fdopen(fd,'rb',closefd=False) as stream: data=stream.read(64*1024*1024+1)
        check(len(data)<=64*1024*1024 and (expected is None or sha(data)==expected),'staged hash mismatch')
        return data
    finally: os.close(fd)
def invoke(context,directory):
    budget=context['profile']['phaseTimeoutSeconds'][context['phase']];check(type(budget)is int and 1<=budget<=600,'phase budget')
    child=subprocess.Popen([sys.executable,'-I',os.path.join(directory,'hook.py'),context['phase']],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C'})
    try: output,error=child.communicate(json.dumps(context),timeout=budget)
    except BaseException:
        try:
            try: os.killpg(child.pid,signal.SIGKILL)
            except ProcessLookupError: pass
        finally: child.wait()
        raise
    check(child.returncode==0,'transaction hook failed: '+error[-1000:])
    check(len(output)<=1024*1024,'hook receipt budget')
    result=json.loads(output)
    check(all(result.get(k)==context[k] for k in ('protocol','transaction','release','phase')),'unbound hook receipt')
    check(isinstance(result.get('bootId'),str) and result['bootId'],'missing observed boot identity')
    return result
def run(request):
    check(request['protocol']==1,'protocol')
    if 'authorization'in request:
        raw=base64.b64decode(request['authorizationBytes'],validate=True);check(len(raw)<=1024*1024 and sha(raw)==request['authorizationSha256'] and json.loads(raw)==request['authorization'],'authorization bytes/pin mismatch')
        check(request['authorization'].get('phase')in('prepare','verify','observe','rollback')and request['authorization'].get('transaction')==request['transaction'],'authorization binding')
    transaction=request['transaction'];check(len(transaction)==36 and all(c in 'abcdef0123456789-' for c in transaction),'transaction id')
    if request.get('action','deploy')=='deploy':
        budgets=request['profile']['phaseTimeoutSeconds'];check(set(budgets)=={'prepare','quiesce','backup','activate','verify','protect','observe','rollback','inspect'}and all(type(v)is int and 1<=v<=600 for v in budgets.values()),'bounded phase budgets required')
    action=request.get('action','deploy');check(action in('deploy','inspect','rollback'),'action')
    root=request['root'];private_dir(root,action=='deploy')
    # The root lock is never unlinked: every UUID shares one inode/authority.
    # Durable active ownership outlives the invocation across reboot/pending.
    import fcntl
    lock=os.open(os.path.join(root,'deployment.lock'),os.O_RDWR|(os.O_CREAT if action=='deploy'else 0)|os.O_NOFOLLOW,0o600)
    directory=os.path.join(root,'transaction-'+transaction)
    active=os.path.join(root,'active.json')
    binding={k:request[k] for k in ('transaction','release','app','profile','hookSha256')} if action=='deploy'else None
    try:
        lockstat=os.fstat(lock)
        check(stat.S_ISREG(lockstat.st_mode) and lockstat.st_uid==os.getuid() and lockstat.st_mode&0o077==0,'unsafe root deployment lock')
        try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError: raise RuntimeError('another deployment invocation owns this release root')
        statepath=os.path.join(directory,'state.json')
        if action in('inspect','rollback'):
            private_dir(directory)
            statebytes=regular(statepath);prior=json.loads(statebytes);binding=prior['binding']
            hookpath=os.path.join(directory,'hook.py');regular(hookpath,binding['hookSha256'])
            manifest=json.loads(regular(os.path.join(directory,'manifest.json')))
            context={**binding,'protocol':1,'phase':'inspect'if action=='inspect'else'rollback','releaseDirectory':os.path.join(directory,'release'),'manifest':manifest,'previous':prior['receipts']}
            if action=='inspect':
                observation=invoke(context,directory)
                check(observation.get('status')=='inspection'and observation.get('readOnly')is True,'product inspection refused')
                return {**binding,'status':'inspection','receipts':prior['receipts'],'transportState':prior,'transportStateSHA256':sha(statebytes),'product':observation}
            check(os.path.lexists(active)and json.loads(regular(active))==binding,'rollback requires exact active transaction owner')
            auth=request.get('authorization',{})
            check(auth.get('phase')=='rollback'and all(auth.get(k)==binding[k]for k in('transaction','release','hookSha256'))and auth.get('transportStateSHA256')==sha(statebytes),'explicit rollback state/owner authorization required')
            prior.setdefault('recoveries',[]).append({'fromStateSHA256':sha(statebytes),'fromInflight':prior.get('inflight'),'authorizationSHA256':request['authorizationSha256']});prior['inflight']='rollback';save(statepath,prior)
            context['authorization']=auth;context['authorizationSha256']=request['authorizationSha256']
            result=invoke(context,directory)
            check(result.get('status')=='rolled_back'and result.get('rollbackVerified')is True and result.get('statePreserved')is True,'explicit rollback verification refused')
            prior['receipts'].append(result);prior.pop('inflight');prior['next']='failed';save(statepath,prior);os.unlink(active);sync_dir(root)
            return {**binding,'status':'rolled_back','receipts':prior['receipts']}
        if os.path.lexists(statepath):
            prior=json.loads(regular(statepath))
            if prior.get('next')=='complete':
                check(prior['binding']==binding,'completed receipt binding changed')
                return {**binding,'status':'complete','historical':True,'receipts':prior['receipts']}
        if os.path.lexists(active): check(json.loads(regular(active))==binding,'another transaction retains active release-root ownership')
        else: save(active,binding)
        private_dir(directory,True)
        try:
            result=locked(request,directory)
            if result['status']=='complete':
                os.unlink(active);sync_dir(root)
            return result
        except Exception:
            # Verified rollback is a terminal result; uncertain/failed rollback
            # leaves ownership held. It can never enable a competing UUID.
            statepath=os.path.join(directory,'state.json')
            if os.path.lexists(statepath):
                state=json.loads(regular(statepath));receipts=state.get('receipts',[])
                if state.get('next')=='failed' and receipts and receipts[-1].get('phase')=='rollback' and receipts[-1].get('rollbackVerified') is True:
                    os.unlink(active);sync_dir(root)
            raise
    finally: os.close(lock)
def locked(r,directory):
    manifest=r['manifest'];check(len(manifest)<=4096 and len(manifest)==len(r['files']),'manifest count')
    check(sha(json.dumps(manifest,separators=(',',':'),ensure_ascii=False).encode())==r['release'],'release identity')
    hook=base64.b64decode(r['hook'],validate=True);check(len(hook)<=1024*1024 and sha(hook)==r['hookSha256'],'hook identity')
    binding={k:r[k] for k in ('transaction','release','app','profile','hookSha256')}
    path=os.path.join(directory,'state.json')
    if os.path.exists(path):
        state=json.loads(regular(path))
        check(state['binding']==binding,'resume binding changed')
        check(not state.get('inflight'),'interrupted phase requires reviewed recovery; automatic retry refused')
        check(state['next']!='failed','failed transaction cannot be silently retried')
    else:
        release=os.path.join(directory,'release');private_dir(release,True)
        total=0;seen=set()
        for entry,data in zip(manifest,r['files']):
            name=entry['path'];parts=name.split('/')
            check(name not in seen and len(parts)<=32 and all(p and p not in ('.','..') and all(c.isalnum() or c in '_.-' for c in p) for p in parts),'release path')
            check(name==r['app'] or name.startswith('resources/'),'release namespace');seen.add(name)
            check({k:v for k,v in data.items() if k!='data'}==entry,'manifest/data mismatch')
            content=base64.b64decode(data['data'],validate=True);total+=len(content)
            check(len(content)==entry['size'] and len(content)<=64*1024*1024 and total<=128*1024*1024 and sha(content)==entry['sha256'],'payload hash/budget')
            check(entry['mode'] in (0o400,0o444,0o600,0o644,0o755),'release mode')
            parent=release
            for p in parts[:-1]: parent=os.path.join(parent,p);private_dir(parent,True)
            write(os.path.join(release,name),content,entry['mode']);sync_dir(parent)
        check(r['app'] in seen and any(p.startswith('resources/') for p in seen),'incomplete release')
        write(os.path.join(directory,'hook.py'),hook,0o400)
        write(os.path.join(directory,'manifest.json'),json.dumps(manifest).encode(),0o400)
        state={'binding':binding,'next':'prepare','receipts':[]};save(path,state);sync_dir(os.path.dirname(directory))
    release=os.path.join(directory,'release')
    for entry in manifest:
        data=regular(os.path.join(release,entry['path']),entry['sha256'])
        check(len(data)==entry['size'] and stat.S_IMODE(os.lstat(os.path.join(release,entry['path'])).st_mode)==entry['mode'],'release size/mode changed')
    regular(os.path.join(directory,'hook.py'),r['hookSha256'])
    def phase(name):
        state['inflight']=name;save(path,state)
        context={**binding,'protocol':1,'phase':name,'releaseDirectory':release,'manifest':manifest,'previous':state['receipts']}
        if 'authorization'in r and r['authorization']['phase']==name:
            auth=r['authorization'];check(all(auth.get(k)==binding[k]for k in('transaction','release','hookSha256')),'authorization binding')
            context['authorization']=auth;context['authorizationSha256']=r['authorizationSha256']
        result=invoke(context,directory)
        state['receipts'].append(result);state.pop('inflight');return result
    if state['next'] in ('observe','complete'):
        observed=phase('observe')
        if observed.get('status')=='awaiting_transition_approval':
            save(path,state);return {**binding,'status':'pending_transition_review','receipts':state['receipts']}
        check(observed.get('status')=='protected' and observed.get('releaseVerified') is True and observed.get('statePreserved') is True and observed.get('sessionVerified') is True,'protected observation refused')
        check(observed['bootId']!=state['activationBoot'],'protected reboot not observed')
        state['next']='complete';save(path,state)
    if state['next']=='prepare':
        result=phase('prepare')
        check(result.get('status') in ('maintenance_required','maintenance_ready','awaiting_transition_approval'),'maintenance admission refused')
        if result['status']=='awaiting_transition_approval':
            save(path,state);return {**binding,'status':'pending_transition_review','receipts':state['receipts']}
        if result['status']=='maintenance_required':
            save(path,state);return {**binding,'status':'pending_maintenance','receipts':state['receipts']}
        check(result.get('profileVerified') is True and result.get('rollbackReady') is True,'profile/rollback admission refused')
        state['activationBoot']=result['bootId'];state['next']='quiesce';save(path,state)
    phases=['quiesce','backup','activate','verify','protect']
    try:
        while state['next'] in phases:
            name=state['next'];result=phase(name)
            if name=='verify' and result.get('status')=='awaiting_transition_approval':
                save(path,state);return {**binding,'status':'pending_transition_review','receipts':state['receipts']}
            if name=='verify' and result.get('status')=='awaiting_acceptance':
                save(path,state);return {**binding,'status':'pending_candidate','receipts':state['receipts']}
            check(result.get('status')=='ok','phase refused '+name)
            if name=='quiesce': check(result.get('processReaped') is True and result.get('flushed') is True,'quiescence refused')
            if name=='backup': check(result.get('backupVerified') is True and isinstance(result.get('backupSha256'),str) and len(result['backupSha256'])==64,'backup refused')
            if name=='verify': check(result.get('releaseVerified') is True and result.get('statePreserved') is True and result.get('sessionVerified') is True,'candidate verification refused')
            if name=='protect':
                check(result.get('rebootRequired') is True,'protection must be observed in subsequent boot')
                state['next']='observe'
            else: state['next']=phases[phases.index(name)+1]
            save(path,state)
    except Exception:
        # The hook may have mutated before an error or transport timeout. Keep
        # its exact inflight phase; only a separate state-bound recovery may
        # invoke rollback. Never retry or compensate an uncertain phase here.
        state['failedPhase']=state.get('inflight',state['next']);save(path,state)
        raise
    return {**binding,'status':'complete' if state['next']=='complete' else 'pending_protected_boot','receipts':state['receipts']}
if __name__=='__main__':
    try:
        raw=sys.stdin.buffer.read(180*1024*1024+1);check(len(raw)<=180*1024*1024,'request budget')
        print(json.dumps(run(json.loads(raw))))
    except Exception as error:
        print(str(error),file=sys.stderr);sys.exit(1)
