(function(){'use strict';var layout=document.querySelector('.dashboard-layout');if(!layout)return;var sidebar=document.getElementById('memberSidebar');var toggles=[].slice.call(layout.querySelectorAll('[data-sidebar-open]'));var closers=[].slice.call(layout.querySelectorAll('[data-sidebar-close]'));var collapse=layout.querySelector('[data-sidebar-collapse]');var previousOverflow='';function mobile(){return window.matchMedia('(max-width:850px)').matches}function open(){if(!sidebar)return;layout.classList.add('sidebar-open');toggles.forEach(function(b){b.setAttribute('aria-expanded','true');b.setAttribute('aria-label','Close navigation')});if(mobile()){previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden'}}function close(){layout.classList.remove('sidebar-open');toggles.forEach(function(b){b.setAttribute('aria-expanded','false');b.setAttribute('aria-label','Open navigation')});document.body.style.overflow=previousOverflow}toggles.forEach(function(b){b.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();layout.classList.contains('sidebar-open')?close():open()})});closers.forEach(function(b){b.addEventListener('click',function(e){e.preventDefault();close()})});if(collapse)collapse.addEventListener('click',function(){layout.classList.toggle('sidebar-collapsed');collapse.setAttribute('aria-expanded',String(!layout.classList.contains('sidebar-collapsed')))});if(sidebar)sidebar.addEventListener('click',function(e){var a=e.target.closest('nav a');if(a&&mobile()&&a.getAttribute('aria-disabled')!=='true')close()});document.addEventListener('keydown',function(e){if(e.key==='Escape')close()});var railScrollButtons=layout.querySelectorAll('[data-dashboard-rail-scroll]');railScrollButtons.forEach(function(btn){btn.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();if(!sidebar)return;var nav=sidebar.querySelector('nav[aria-label="Member dashboard navigation"]')||sidebar.querySelector('nav');if(!nav)return;var direction=btn.getAttribute('data-dashboard-rail-scroll')==='up'?-1:1;nav.scrollTo({top:Math.max(0,nav.scrollTop+direction*Math.max(180,Math.round(nav.clientHeight*.7))),behavior:'smooth'})})});window.addEventListener('resize',function(){if(!mobile())close()},{passive:true});
/* Copy controls on the overview sidebar (including Monarch ID) must work on
   desktop browsers and Android WebViews with or without Clipboard API access. */
(function(){
  function legacyCopy(value){
    var field=document.createElement('textarea');
    field.value=value;
    field.setAttribute('readonly','');
    field.style.position='fixed';
    field.style.left='-9999px';
    field.style.top='0';
    document.body.appendChild(field);
    field.focus();
    field.select();
    var copied=false;
    try{copied=document.execCommand('copy')}catch(_){}
    field.remove();
    return copied;
  }
  async function copyValue(value){
    if(!value)return false;
    if(navigator.clipboard&&window.isSecureContext){
      try{await navigator.clipboard.writeText(value);return true}catch(_){}
    }
    return legacyCopy(value);
  }
  document.addEventListener('click',async function(event){
    var button=event.target.closest('[data-copy-target]');
    if(!button)return;
    var targetId=button.getAttribute('data-copy-target');
    var target=targetId&&document.getElementById(targetId);
    if(!target)return;
    event.preventDefault();
    var value=String(('value' in target)?target.value:target.textContent||'').trim();
    var original=button.getAttribute('data-copy-label')||button.textContent||'Copy';
    button.disabled=true;
    var ok=await copyValue(value);
    button.textContent=ok?'Copied ✓':'Select and copy';
    button.setAttribute('aria-live','polite');
    if(!ok&&target.select){target.focus();target.select()}
    window.setTimeout(function(){button.textContent=original;button.disabled=false},1800);
  });
})();

/* Keep the member notification badge synchronized with the authenticated server count. */
(function(){var bells=[].slice.call(document.querySelectorAll('.dashboard-notification-bell, .member-notification-bell'));if(!bells.length)return;var endpoint='/api/notifications/unread-count';function paint(count){count=Math.max(0,Number(count)||0);bells.forEach(function(bell){var badge=bell.querySelector('.dashboard-notification-bell-count, .notification-nav-count, [data-unread-count-badge]');if(count>0){if(!badge){badge=document.createElement('span');badge.className=bell.classList.contains('dashboard-notification-bell')?'dashboard-notification-bell-count':'notification-nav-count';badge.setAttribute('data-unread-count-badge','');bell.appendChild(badge)}badge.textContent=count>99?'99+':String(count);badge.hidden=false;bell.setAttribute('aria-label','Notifications, '+count+' unread');bell.setAttribute('title',count+' unread notifications')}else{if(badge){badge.textContent='';badge.hidden=true}bell.setAttribute('aria-label','Notifications');bell.setAttribute('title','Notifications')}})}async function refreshCount(){try{var response=await fetch(endpoint,{credentials:'same-origin',cache:'no-store',headers:{'Accept':'application/json'}});if(!response.ok)return;var data=await response.json();if(typeof data.count==='number')paint(data.count)}catch(_){}}refreshCount();window.setInterval(refreshCount,30000);document.addEventListener('visibilitychange',function(){if(!document.hidden)refreshCount()});window.addEventListener('pageshow',refreshCount)})();})();