import React, { useCallback, useEffect, useState } from "react";
import {
  ShieldCheck, Users, MapPin, Bell, CalendarDays, Lock,
  Plus, Siren, CheckCircle2, Clock, LogOut, RefreshCw,
  ArrowRight, Mail, X, Eye, EyeOff, Menu, HeartHandshake,
  Activity, Navigation, UserRound, AlertTriangle, LayoutDashboard
} from "lucide-react";
import { supabase } from "./supabaseClient";

const fmt = (v) => v ? new Date(v).toLocaleString() : "—";

const errorText = (e) => {
  const m = e?.message || "Something went wrong.";
  if (/invalid login credentials/i.test(m)) return "Incorrect email or password.";
  if (/email not confirmed/i.test(m)) return "Please confirm your email.";
  if (/row-level security|permission denied/i.test(m)) return "Database permission denied. Check Supabase RLS policies.";
  return m;
};

export default function App() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);

  const [mode, setMode] = useState("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("adult");
  const [showPassword, setShowPassword] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authInfo, setAuthInfo] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [recovery, setRecovery] = useState(false);

  const [page, setPage] = useState("Overview");
  const [mobile, setMobile] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  const [plans, setPlans] = useState([]);
  const [events, setEvents] = useState([]);
  const [links, setLinks] = useState([]);
  const [profiles, setProfiles] = useState({});
  const [locations, setLocations] = useState([]);

  const [planTitle, setPlanTitle] = useState("Reach home safely");
  const [destination, setDestination] = useState("");
  const [arrival, setArrival] = useState(() => {
    const d = new Date(Date.now() + 3600000);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString().slice(0, 16);
  });
  const [note, setNote] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [sharing, setSharing] = useState(false);
  const [locationError, setLocationError] = useState("");

  // Readable place names, stored separately for each family member
  const [locationPlaces, setLocationPlaces] = useState({});

  const user = session?.user;
  const isParent = profile?.role === "parent";

  const notify = (m) => {
    setToast(m);
    setTimeout(() => setToast(""), 3500);
  };

  // AUTH SESSION
  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (error) setError(errorText(error));
      setSession(data?.session || null);
      setLoading(false);
    });

    const { data: { subscription } } =
      supabase.auth.onAuthStateChange((event, next) => {
        setSession(next);
        if (event === "PASSWORD_RECOVERY") {
          setRecovery(true);
          setMode("update");
          setAuthInfo("Enter your new password.");
        }
      });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  // LOAD LOGGED-IN USER PROFILE
  useEffect(() => {
    let active = true;

    async function getProfile() {
      if (!user) {
        setProfile(null);
        setPlans([]);
        setEvents([]);
        setLinks([]);
        setProfiles({});
        setLocations([]);
        return;
      }

      setProfileLoading(true);

      const { data, error } = await supabase
        .from("sg_profiles")
        .select("user_id,display_name,role,location_sharing_enabled")
        .eq("user_id", user.id)
        .single();

      if (!active) return;

      if (error) {
        setError(errorText(error));
        setProfile(null);
      } else {
        setProfile(data);
        setSharing(Boolean(data.location_sharing_enabled));
      }

      setProfileLoading(false);
    }

    getProfile();
    return () => { active = false; };
  }, [user?.id]);

  // LOAD APP DATA
  const loadData = useCallback(async () => {
    if (!user || !profile) return;

    const results = await Promise.all([
      supabase.from("sg_family_links").select("*").order("created_at", { ascending: false }),
      supabase.from("sg_safety_plans").select("*").order("expected_at", { ascending: true }),
      supabase.from("sg_safety_events").select("*").order("created_at", { ascending: false }).limit(100),
      supabase.from("sg_profiles").select("user_id,display_name,role"),
      supabase.from("sg_live_locations").select("*").order("recorded_at", { ascending: false })
    ]);

    const failed = results.find((r) => r.error);
    if (failed) {
      setError(errorText(failed.error));
      return;
    }

    setLinks(results[0].data || []);
    setPlans(results[1].data || []);
    setEvents(results[2].data || []);
    setLocations(results[4].data || []);

    const map = {};
    (results[3].data || []).forEach((p) => {
      map[p.user_id] = p;
    });
    setProfiles(map);
  }, [user?.id, profile?.role]);

  useEffect(() => {
    if (user && profile) loadData();
  }, [user?.id, profile?.role, loadData]);

  // REALTIME
  useEffect(() => {
    if (!user || !profile) return;

    const channel = supabase.channel(`safe-${user.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "sg_family_links" }, loadData)
      .on("postgres_changes", { event: "*", schema: "public", table: "sg_safety_plans" }, loadData)
      .on("postgres_changes", { event: "*", schema: "public", table: "sg_safety_events" }, loadData)
      .on("postgres_changes", { event: "*", schema: "public", table: "sg_live_locations" }, loadData)
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, [user?.id, profile?.role, loadData]);

  // ADULT GPS SHARING
  useEffect(() => {
    if (!user || profile?.role !== "adult" || !profile.location_sharing_enabled) return;

    if (!navigator.geolocation) {
      setLocationError("GPS is not supported by this browser.");
      return;
    }

    let active = true;
    let lastSave = 0;

    const watch = navigator.geolocation.watchPosition(
      async (pos) => {
        if (!active) return;

        const row = {
          owner_id: user.id,
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy_m: pos.coords.accuracy,
          recorded_at: new Date(pos.timestamp || Date.now()).toISOString()
        };

        setLocations((old) => [
          row,
          ...old.filter((x) => x.owner_id !== user.id)
        ]);

        if (Date.now() - lastSave < 20000) return;
        lastSave = Date.now();

        const { error } = await supabase
          .from("sg_live_locations")
          .upsert(row, { onConflict: "owner_id" });

        if (active && error) setLocationError(errorText(error));
      },
      (e) => {
        if (active) {
          setLocationError(
            e.code === 1
              ? "Allow location permission in your browser."
              : "Unable to get GPS location. Check your device settings."
          );
        }
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
    );

    return () => {
      active = false;
      navigator.geolocation.clearWatch(watch);
    };
  }, [user?.id, profile?.role, profile?.location_sharing_enabled]);

  // SIGNUP / SIGNIN / PASSWORD RECOVERY
  const handleAuth = async (e) => {
    e.preventDefault();
    setAuthBusy(true);
    setAuthError("");
    setAuthInfo("");

    try {
      const cleanEmail = email.trim().toLowerCase();

      if (mode === "signup") {
        if (!name.trim()) throw new Error("Enter your name.");
        if (password.length < 8) throw new Error("Password must have at least 8 characters.");

        const { data, error } = await supabase.auth.signUp({
          email: cleanEmail,
          password,
          options: {
            data: {
              display_name: name.trim(),
              role
            },
            emailRedirectTo: window.location.origin
          }
        });

        if (error) throw error;

        if (data.session) {
          setSession(data.session);
          notify("Account created successfully.");
        } else {
          setMode("signin");
          setAuthInfo("Account created. Sign in with your new credentials.");
        }
      }

      if (mode === "signin") {
        const { data, error } = await supabase.auth.signInWithPassword({
          email: cleanEmail,
          password
        });
        if (error) throw error;
        setSession(data.session);
      }

      if (mode === "forgot") {
        const { error } = await supabase.auth.resetPasswordForEmail(cleanEmail, {
          redirectTo: window.location.origin
        });
        if (error) throw error;
        setAuthInfo("Password reset email requested. Check your inbox.");
      }

      if (mode === "update") {
        if (password.length < 8) throw new Error("Password must have at least 8 characters.");
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        await supabase.auth.signOut();
        setSession(null);
        setRecovery(false);
        setMode("signin");
        setAuthInfo("Password updated. Please sign in.");
      }
    } catch (e) {
      setAuthError(errorText(e));
    } finally {
      setAuthBusy(false);
    }
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setSession(null);
    setProfile(null);
    setPage("Overview");
  };

  const addEvent = async (type, title, details, planId = null) => {
    const { error } = await supabase.from("sg_safety_events").insert({
      owner_id: user.id,
      plan_id: planId,
      event_type: type,
      title,
      details
    });
    if (error) throw error;
  };

  // CREATE SAFETY PLAN
  const createPlan = async (e) => {
    e.preventDefault();
    if (!destination.trim()) return setError("Enter a destination.");
    if (new Date(arrival).getTime() <= Date.now()) return setError("Choose a future arrival time.");

    setBusy(true);
    setError("");

    try {
      const { data, error } = await supabase.from("sg_safety_plans")
        .insert({
          owner_id: user.id,
          title: planTitle,
          destination,
          expected_at: new Date(arrival).toISOString(),
          note,
          status: "scheduled"
        })
        .select()
        .single();

      if (error) throw error;

      await addEvent("plan_created", "Safety plan created", `${planTitle} · ${destination}`, data.id);

      setDestination("");
      setNote("");
      setPage("Overview");
      await loadData();
      notify("Safety plan created.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmSafe = async (plan) => {
    setBusy(true);
    try {
      const { error } = await supabase.from("sg_safety_plans")
        .update({
          status: "confirmed",
          checked_at: new Date().toISOString()
        })
        .eq("id", plan.id)
        .eq("owner_id", user.id);

      if (error) throw error;

      await addEvent("check_in", "Safe arrival confirmed", `${profile.display_name || user.email} confirmed safe arrival.`, plan.id);
      await loadData();
      notify("Your safe arrival has been recorded.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const sendSOS = async () => {
    setBusy(true);
    try {
      await addEvent("sos", "SOS help request", `${profile.display_name || user.email} requested help.`);
      await loadData();
      notify("SOS event recorded. Contact emergency services directly if you are in danger.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  // FAMILY INVITATION
  const sendInvite = async (e) => {
    e.preventDefault();
    setBusy(true);

    try {
      const clean = inviteEmail.trim().toLowerCase();
      if (clean === user.email.toLowerCase()) throw new Error("You cannot invite yourself.");

      const { error } = await supabase.from("sg_family_links").insert({
        parent_id: user.id,
        adult_email: clean,
        status: "pending"
      });

      if (error) throw error;

      setInviteEmail("");
      await loadData();
      notify("Invitation created. Ask the Adult to sign in and accept it.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const acceptInvite = async (link) => {
    setBusy(true);

    try {
      const { error } = await supabase.from("sg_family_links")
        .update({
          adult_id: user.id,
          status: "accepted",
          accepted_at: new Date().toISOString()
        })
        .eq("id", link.id);

      if (error) throw error;

      await loadData();
      notify("Family invitation accepted.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const updateSharing = async (value) => {
    setSharing(value);

    const { error } = await supabase.from("sg_profiles")
      .update({ location_sharing_enabled: value })
      .eq("user_id", user.id);

    if (error) {
      setSharing(!value);
      setError(errorText(error));
      return;
    }

    setProfile((p) => ({ ...p, location_sharing_enabled: value }));

    if (!value) {
      await supabase.from("sg_live_locations").delete().eq("owner_id", user.id);
      setLocations((old) => old.filter((x) => x.owner_id !== user.id));
    }

    notify(value ? "Location sharing enabled." : "Location sharing stopped.");
  };
    // FAMILY CONNECTIONS
  const acceptedLinks = links.filter(
    (x) => x.status === "accepted"
  );

  const pendingInvites = links.filter(
    (x) =>
      x.status === "pending" &&
      !x.adult_id &&
      x.adult_email?.toLowerCase() === user?.email?.toLowerCase()
  );

  const myPlans = isParent
    ? plans.filter((p) =>
        acceptedLinks.some((link) => link.adult_id === p.owner_id)
      )
    : plans.filter((p) => p.owner_id === user?.id);

  const openPlans = myPlans.filter(
    (p) => p.status === "scheduled"
  );

  const safePlans = myPlans.filter(
    (p) => p.status === "confirmed"
  );

  const overdue = openPlans.filter(
    (p) =>
      Date.now() > new Date(p.expected_at).getTime() + 300000
  );

  // LOCATIONS OF ALL ACCEPTED ADULTS (one latest location per adult)
  const linkedAdultIds = acceptedLinks
    .filter((link) => link.parent_id === user?.id && link.adult_id)
    .map((link) => link.adult_id);

  const parentLocations = linkedAdultIds
    .map((adultId) =>
      locations
        .filter((item) => item.owner_id === adultId)
        .sort(
          (a, b) =>
            new Date(b.recorded_at || 0) - new Date(a.recorded_at || 0)
        )[0]
    )
    .filter(Boolean);

  const location = isParent
    ? parentLocations[0] || null
    : locations.find((item) => item.owner_id === user?.id) || null;

  // REVERSE GEOCODING: resolve a readable place for each visible member
  const geocodeKey = (isParent ? parentLocations : location ? [location] : [])
    .map((item) =>
      `${item.owner_id}:${Number(item.latitude).toFixed(4)}:${Number(item.longitude).toFixed(4)}`
    )
    .join("|");

  useEffect(() => {
    const targets = isParent
      ? parentLocations
      : location
        ? [location]
        : [];

    if (!targets.length) {
      setLocationPlaces({});
      return;
    }

    let active = true;
    const controller = new AbortController();

    setLocationPlaces((old) => {
      const next = { ...old };
      targets.forEach((item) => {
        if (!next[item.owner_id]) next[item.owner_id] = "Finding place name...";
      });
      return next;
    });

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    async function lookupAllPlaces() {
      const updates = {};

      // Nominatim is rate-limited; request locations sequentially.
      for (let index = 0; index < targets.length; index += 1) {
        const item = targets[index];
        const lat = Number(item.latitude);
        const lon = Number(item.longitude);

        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          updates[item.owner_id] = "Invalid GPS coordinates";
          continue;
        }

        try {
          if (index > 0) await wait(1100);
          if (!active) return;

          const url = new URL("https://nominatim.openstreetmap.org/reverse");
          url.searchParams.set("format", "jsonv2");
          url.searchParams.set("lat", String(lat));
          url.searchParams.set("lon", String(lon));
          url.searchParams.set("zoom", "18");
          url.searchParams.set("addressdetails", "1");

          const response = await fetch(url.toString(), {
            signal: controller.signal
          });
          if (!response.ok) throw new Error(`Lookup failed: ${response.status}`);

          const result = await response.json();
          const address = result.address || {};
          const area =
            address.suburb || address.neighbourhood || address.residential ||
            address.quarter || address.hamlet;
          const city =
            address.city || address.town || address.village ||
            address.municipality || address.county;
          const parts = [area, city, address.state, address.country].filter(Boolean);

          updates[item.owner_id] = parts.length
            ? [...new Set(parts)].join(", ")
            : result.display_name || "Place name unavailable";
        } catch (err) {
          if (err.name === "AbortError") return;
          console.error("Location lookup error:", err);
          updates[item.owner_id] = "Place name unavailable — use Open map";
        }
      }

      if (active) setLocationPlaces((old) => ({ ...old, ...updates }));
    }

    lookupAllPlaces();

    return () => {
      active = false;
      controller.abort();
    };
  }, [isParent, geocodeKey]);

  const badge = (value, color = "grey") => (
    <span className={`sg-badge ${color}`}>
      {value}
    </span>
  );

  // SAFETY PLAN CARD
  const planCard = (p) => (
    <div className="sg-plan" key={p.id}>
      <div className="sg-plan-icon">
        <CalendarDays size={20} />
      </div>

      <div className="sg-plan-info">
        <b>{p.title}</b>

        <span>
          <MapPin size={13} /> {p.destination}
        </span>

        <small>
          <Clock size={13} /> {fmt(p.expected_at)}
        </small>

        {p.status === "confirmed"
          ? badge("Safe arrival confirmed", "green")
          : badge("Awaiting check-in", "orange")}
      </div>

      {!isParent && p.status === "scheduled" && (
        <button
          className="sg-button green-button"
          disabled={busy}
          onClick={() => confirmSafe(p)}
        >
          <CheckCircle2 size={15} /> I'm Safe
        </button>
      )}
    </div>
  );

  // LOCATION DISPLAY
  const locationPanel = (item = location, memberName = "") => (
    <div className="sg-location">
      {item ? (
        <>
          <div className="sg-coordinate">
            <MapPin size={25} />

            <div>
              <b>
                {memberName || (isParent
                  ? "Linked adult location"
                  : "Your device location")}
              </b>

              <p className="sg-place-name">
                {locationPlaces[item.owner_id] || "Finding place name..."}
              </p>

              <small>
                GPS: {Number(item.latitude).toFixed(5)},
                {" "}
                {Number(item.longitude).toFixed(5)}
              </small>

              <small>
                Accuracy: {item.accuracy_m
                  ? `${Math.round(item.accuracy_m)} metres`
                  : "Not available"}
              </small>

              <small>
                Updated {fmt(item.recorded_at)}
              </small>
            </div>
          </div>

          <a
            className="sg-button"
            target="_blank"
            rel="noreferrer"
            href={`https://www.google.com/maps?q=${item.latitude},${item.longitude}`}
          >
            Open map <ArrowRight size={15} />
          </a>
        </>
      ) : (
        <div className="sg-empty">
          No live location available right now.
          {isParent
            ? " Make sure an accepted Adult has enabled location sharing."
            : " Enable location sharing and allow browser GPS permission."}
        </div>
      )}

      {locationError && (
        <p className="sg-error">{locationError}</p>
      )}
    </div>
  );

  // PARENT DASHBOARD
  const parentDashboard = () => (
    <div className="parent-ui">
      <div className="parent-banner">
        <div>
          <span className="parent-label">
            <ShieldCheck size={16} /> PARENT CONTROL CENTRE
          </span>

          <h1>Family Monitoring</h1>

          <p>
            Welcome, {profile.display_name || user.email}.
            Monitor your connected family's safety.
          </p>
        </div>

        <div className="parent-emblem">
          <ShieldCheck size={65} />
          <b>FAMILY<br />PROTECTION</b>
        </div>
      </div>

      <div className="parent-stats">
        <div>
          <small>FAMILY CONNECTIONS</small>
          <b>{acceptedLinks.length}</b>
          <span>Accepted members</span>
        </div>

        <div>
          <small>ACTIVE PLANS</small>
          <b>{openPlans.length}</b>
          <span>Awaiting check-in</span>
        </div>

        <div>
          <small>SAFE CHECK-INS</small>
          <b>{safePlans.length}</b>
          <span>Confirmed arrivals</span>
        </div>

        <div className="stat-alert">
          <small>NEEDS ATTENTION</small>
          <b>{overdue.length}</b>
          <span>Overdue plans</span>
        </div>
      </div>

      <div className="parent-grid">
        <section className="parent-panel">
          <div className="panel-title">
            <div>
              <small>FAMILY NETWORK</small>
              <h2>Manage family members</h2>
              <p>Invite an Adult to connect to your family account.</p>
            </div>
            <Users size={25} />
          </div>

          <form
            className="parent-invite-form"
            onSubmit={sendInvite}
          >
            <input
              type="email"
              required
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="Adult's email address"
            />

            <button className="parent-btn" disabled={busy}>
              <Plus size={16} /> Invite Adult
            </button>
          </form>

          {links.filter((x) => x.parent_id === user.id).length
            ? links
                .filter((x) => x.parent_id === user.id)
                .map((x) => (
                  <div className="family-row" key={x.id}>
                    <span className="family-avatar">
                      <UserRound />
                    </span>

                    <div>
                      <b>
                        {profiles[x.adult_id]?.display_name ||
                          x.adult_email}
                      </b>
                      <small>{x.adult_email}</small>
                    </div>

                    {badge(
                      x.status,
                      x.status === "accepted" ? "green" : "orange"
                    )}
                  </div>
                ))
            : (
              <div className="sg-empty">
                No family members yet. Invite an Adult using their account email.
              </div>
            )}
        </section>

        <section className="parent-panel">
          <div className="panel-title">
            <div>
              <small>LIVE FAMILY VIEW</small>
              <h2>Adult location monitoring</h2>
              <p>Location shared by your accepted family member.</p>
            </div>
            <MapPin size={25} />
          </div>

          {acceptedLinks.length ? acceptedLinks.map((link) => {
            const adult = profiles[link.adult_id];
            const adultName = adult?.display_name || link.adult_email;
            const adultLocation = parentLocations.find(
              (item) => item.owner_id === link.adult_id
            );

            return (
              <div key={link.id} style={{ marginBottom: 20 }}>
                <h3 style={{ margin: "12px 0" }}>{adultName}</h3>
                {locationPanel(adultLocation, adultName)}
              </div>
            );
          }) : (
            <div className="sg-empty">No accepted adults are connected yet.</div>
          )}
        </section>
      </div>

      <div className="parent-grid">
        <section className="parent-panel">
          <div className="panel-title">
            <div>
              <small>SAFETY FOLLOW-UP</small>
              <h2>Check-in monitor</h2>
              <p>Plans that may need your attention.</p>
            </div>
            <Clock size={25} />
          </div>

          {overdue.length
            ? overdue.map(planCard)
            : (
              <div className="sg-success">
                <CheckCircle2 />
                No overdue check-ins right now.
              </div>
            )}

          {openPlans.length > 0 && (
            <div className="parent-subtitle">
              Awaiting confirmation
            </div>
          )}

          {openPlans.slice(0, 4).map(planCard)}
        </section>

        <section className="parent-panel">
          <div className="panel-title">
            <div>
              <small>FAMILY ACTIVITY</small>
              <h2>Recent alerts</h2>
              <p>Latest safety events from your family.</p>
            </div>
            <Bell size={25} />
          </div>

          {events.slice(0, 6).length
            ? events.slice(0, 6).map((x) => (
                <div className="sg-activity" key={x.id}>
                  <span className={
                    x.event_type === "sos"
                      ? "activity-red"
                      : "activity-green"
                  }>
                    {x.event_type === "sos"
                      ? <Siren />
                      : <Activity />}
                  </span>

                  <div>
                    <b>{x.title}</b>
                    <p>{x.details}</p>
                    <small>{fmt(x.created_at)}</small>
                  </div>
                </div>
              ))
            : (
              <div className="sg-empty">
                No family activity yet.
              </div>
            )}
        </section>
      </div>
    </div>
  );

  // ADULT DASHBOARD
  const adultDashboard = () => (
    <div className="adult-ui">
      <div className="adult-banner">
        <div>
          <span className="adult-label">
            <HeartHandshake size={16} /> PERSONAL SAFETY SPACE
          </span>

          <h1>Your safety. Your choice.</h1>

          <p>
            Welcome, {profile.display_name || user.email}.
            Stay connected while keeping control of your privacy.
          </p>
        </div>

        <div className="adult-emblem">
          <ShieldCheck size={55} />
          <b>YOU ARE<br />IN CONTROL</b>
        </div>
      </div>

      <div className="adult-status">
        <div className="adult-status-icon">
          <ShieldCheck size={28} />
        </div>

        <div className="adult-status-copy">
          <small>YOUR SAFETY STATUS</small>

          <h2>
            {overdue.length
              ? "You have an overdue plan"
              : openPlans.length
                ? "You have a planned check-in"
                : "You're all caught up"}
          </h2>

          <p>
            {overdue.length
              ? "Please review your plan and contact your trusted person if needed."
              : "Create a plan before your next journey and check in when you arrive."}
          </p>
        </div>

        <button
          className="adult-sos"
          onClick={sendSOS}
          disabled={busy}
        >
          <Siren /> SOS EMERGENCY
        </button>
      </div>

      <div className="adult-actions">
        <button onClick={() => setPage("My Safety Plans")}>
          <span><Plus /></span>
          <b>Create safety plan</b>
          <small>Plan your next journey</small>
          <ArrowRight />
        </button>

        <button onClick={() => {
          const p = myPlans.find(
            (x) => x.status === "scheduled"
          );
          if (p) confirmSafe(p);
          else notify("You don't have a pending plan.");
        }}>
          <span><CheckCircle2 /></span>
          <b>I'm Safe</b>
          <small>Confirm your safe arrival</small>
          <ArrowRight />
        </button>

        <button onClick={() => setPage("My Location")}>
          <span><Navigation /></span>
          <b>My location</b>
          <small>
            {sharing ? "Sharing is enabled" : "Sharing is turned off"}
          </small>
          <ArrowRight />
        </button>
      </div>

      <div className="adult-grid">
        <section className="adult-panel">
          <div className="panel-title">
            <div>
              <small>MY JOURNEYS</small>
              <h2>My safety plans</h2>
              <p>Your personal journey schedule.</p>
            </div>
            <CalendarDays />
          </div>

          {myPlans.length
            ? myPlans.slice(0, 5).map(planCard)
            : (
              <div className="sg-empty">
                You haven't created a safety plan yet.
              </div>
            )}

          <button
            className="adult-text-button"
            onClick={() => setPage("My Safety Plans")}
          >
            View all plans <ArrowRight size={15} />
          </button>
        </section>

        <section className="adult-panel">
          <div className="panel-title">
            <div>
              <small>TRUSTED CONTACT</small>
              <h2>Parent connection</h2>
              <p>Manage invitations and location permissions.</p>
            </div>
            <Users />
          </div>

          {pendingInvites.length
            ? pendingInvites.map((x) => (
                <div className="adult-invite-row" key={x.id}>
                  <div>
                    <b>Family invitation</b>
                    <small>{fmt(x.created_at)}</small>
                  </div>

                  <button
                    className="adult-btn"
                    onClick={() => acceptInvite(x)}
                    disabled={busy}
                  >
                    Accept
                  </button>
                </div>
              ))
            : (
              <div className="sg-empty">
                {acceptedLinks.length
                  ? "You have an accepted family connection."
                  : "No parent invitation yet."}
              </div>
            )}

          <div className="sharing-row">
            <div>
              <b>Live location sharing</b>
              <small>{sharing ? "Enabled" : "Disabled"}</small>
            </div>

            <button
              className={`sharing-toggle ${sharing ? "on" : ""}`}
              onClick={() => updateSharing(!sharing)}
            >
              {sharing ? "ON" : "OFF"}
            </button>
          </div>

          {locationPanel()}
        </section>
      </div>

      <section className="adult-panel">
        <div className="panel-title">
          <div>
            <small>MY ACTIVITY</small>
            <h2>Personal safety history</h2>
            <p>Your recent check-ins and activity.</p>
          </div>
          <Activity />
        </div>

        {events.slice(0, 5).length
          ? events.slice(0, 5).map((x) => (
              <div className="sg-activity" key={x.id}>
                <span className={
                  x.event_type === "sos"
                    ? "activity-red"
                    : "activity-green"
                }>
                  {x.event_type === "sos"
                    ? <Siren />
                    : <CheckCircle2 />}
                </span>

                <div>
                  <b>{x.title}</b>
                  <p>{x.details}</p>
                  <small>{fmt(x.created_at)}</small>
                </div>
              </div>
            ))
          : (
            <div className="sg-empty">
              Your safety activity will appear here.
            </div>
          )}
      </section>
    </div>
  );
  const plansPage = () => (
    <>
      <div className="page-heading">
        <div>
          <small>{isParent ? "PARENT CONTROL CENTRE" : "PERSONAL SAFETY"}</small>
          <h1>{isParent ? "Family safety plans" : "My safety plans"}</h1>
          <p>
            {isParent
              ? "Review plans shared by connected family members."
              : "Create and manage your journey check-ins."}
          </p>
        </div>

        {!isParent && (
          <button className="sg-button" onClick={() => setPage("Create Plan")}>
            <Plus /> New plan
          </button>
        )}
      </div>

      {myPlans.length
        ? myPlans.map(planCard)
        : <div className="sg-empty">No safety plans available.</div>}
    </>
  );

  const createPage = () => (
    <section className="adult-panel">
      <div className="panel-title">
        <div>
          <small>PERSONAL SAFETY</small>
          <h2>Create a safety plan</h2>
          <p>Tell your trusted contact where you are going.</p>
        </div>
        <CalendarDays />
      </div>

      <form className="sg-form" onSubmit={createPlan}>
        <label>
          Plan title
          <input
            value={planTitle}
            onChange={(e) => setPlanTitle(e.target.value)}
            required
          />
        </label>

        <label>
          Destination
          <input
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            required
            placeholder="Enter destination"
          />
        </label>

        <label>
          Expected arrival
          <input
            type="datetime-local"
            value={arrival}
            onChange={(e) => setArrival(e.target.value)}
            required
          />
        </label>

        <label>
          Additional note
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note"
          />
        </label>

        <button className="sg-button" disabled={busy}>
          <Plus /> {busy ? "Saving…" : "Save safety plan"}
        </button>
      </form>
    </section>
  );

  const activityPage = () => (
    <section className={isParent ? "parent-panel" : "adult-panel"}>
      <div className="panel-title">
        <div>
          <small>SAFETY HISTORY</small>
          <h2>{isParent ? "Family activity" : "My activity"}</h2>
          <p>Recent recorded safety events.</p>
        </div>
        <Bell />
      </div>

      {events.length
        ? events.map((x) => (
            <div className="sg-activity" key={x.id}>
              <span className={
                x.event_type === "sos"
                  ? "activity-red"
                  : "activity-green"
              }>
                <Activity />
              </span>

              <div>
                <b>{x.title}</b>
                <p>{x.details}</p>
                <small>{fmt(x.created_at)}</small>
              </div>
            </div>
          ))
        : <div className="sg-empty">No activity recorded yet.</div>}
    </section>
  );

  const privacyPage = () => (
    <section className="adult-panel">
      <div className="panel-title">
        <div>
          <small>PRIVACY CONTROL</small>
          <h2>Location & consent</h2>
          <p>You decide whether to share your location.</p>
        </div>
        <Lock />
      </div>

      {isParent
        ? (
          <div className="sg-empty">
            An Adult controls their own location-sharing permission.
            You can view it only after they accept your family invitation.
          </div>
        )
        : (
          <div className="sharing-row">
            <div>
              <b>Share my live location</b>
              <small>
                Location is shared while this website remains open
                and browser permission is granted.
              </small>
            </div>

            <button
              className={`sharing-toggle ${sharing ? "on" : ""}`}
              onClick={() => updateSharing(!sharing)}
            >
              {sharing ? "ON" : "OFF"}
            </button>
          </div>
        )}

      {locationPanel()}
    </section>
  );

  if (loading || (user && profileLoading)) {
    return (
      <div className="sg-loading">
        <ShieldCheck size={35} />
        <h2>Loading SafeGuardian…</h2>
      </div>
    );
  }

  // AUTH SCREEN
  if (!user || recovery) {
    return (
      <div className="auth-screen">
        <form className="auth-box" onSubmit={handleAuth}>
          <div className="auth-logo">
            <ShieldCheck size={30} />
            <div>
              <b>SafeGuardian</b>
              <small>Family safety platform</small>
            </div>
          </div>

          <span className="auth-kicker">PRIVATE FAMILY SAFETY</span>

          <h1>
            {mode === "signin"
              ? "Welcome back"
              : mode === "signup"
                ? "Create your account"
                : mode === "forgot"
                  ? "Reset password"
                  : "Choose a new password"}
          </h1>

          <p>
            {mode === "signup"
              ? "Register with your own details and select your account role."
              : "Access your personal SafeGuardian account."}
          </p>

          {authError && <div className="auth-error">{authError}</div>}
          {authInfo && <div className="auth-success">{authInfo}</div>}

          {mode === "signup" && (
            <>
              <label>
                Your name
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  placeholder="Enter your name"
                />
              </label>

              <label>
                Choose account type
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                >
                  <option value="adult">Adult</option>
                  <option value="parent">Parent</option>
                </select>
              </label>
            </>
          )}

          {mode !== "update" && (
            <label>
              Email address
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="you@example.com"
              />
            </label>
          )}

          {mode !== "forgot" && (
            <label>
              Password
              <div className="password-input">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  placeholder="At least 8 characters"
                />

                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? <EyeOff /> : <Eye />}
                </button>
              </div>
            </label>
          )}

          {mode === "signin" && (
            <button
              type="button"
              className="auth-link"
              onClick={() => setMode("forgot")}
            >
              Forgot password?
            </button>
          )}

          <button className="auth-submit" disabled={authBusy}>
            {authBusy
              ? "Please wait…"
              : mode === "signin"
                ? "Sign in"
                : mode === "signup"
                  ? "Create account"
                  : mode === "forgot"
                    ? "Send reset link"
                    : "Update password"}

            <ArrowRight size={17} />
          </button>

          {mode !== "update" && (
            <button
              type="button"
              className="auth-link"
              onClick={() => {
                setMode(mode === "signup" ? "signin" : "signup");
                setAuthError("");
                setAuthInfo("");
              }}
            >
              {mode === "signup"
                ? "Already registered? Sign in"
                : "New user? Create an account"}
            </button>
          )}

          {(mode === "forgot" || mode === "update") && (
            <button
              type="button"
              className="auth-link"
              onClick={() => {
                setMode("signin");
                setRecovery(false);
              }}
            >
              Back to sign in
            </button>
          )}

          <div className="auth-security">
            <Lock size={15} />
            Your account is protected by Supabase authentication.
          </div>
        </form>
      </div>
    );
  }

  if (!profile || !["parent", "adult"].includes(profile.role)) {
    return (
      <div className="sg-loading">
        <h2>Account role not found</h2>
        <p>Contact the administrator or sign out.</p>
        <button className="sg-button" onClick={signOut}>
          Sign out
        </button>
      </div>
    );
  }

  const nav = isParent
    ? [
        ["Overview", ShieldCheck],
        ["Family Monitoring", Users],
        ["Check-in Monitor", Clock],
        ["Family Activity", Bell],
        ["Privacy", Lock]
      ]
    : [
        ["Overview", LayoutDashboard],
        ["My Safety Plans", CalendarDays],
        ["My Activity", Activity],
        ["My Location", MapPin],
        ["Privacy", Lock]
      ];

  const renderPage = () => {
    if (page === "Overview") {
      return isParent ? parentDashboard() : adultDashboard();
    }

    if (page === "Family Monitoring") return parentDashboard();
    if (page === "Check-in Monitor") return plansPage();

    if (
      page === "Family Activity" ||
      page === "My Activity"
    ) {
      return activityPage();
    }

    if (page === "My Safety Plans") return plansPage();
    if (page === "Create Plan") return createPage();
    if (page === "My Location") return privacyPage();

    return privacyPage();
  };

  return (
    <div className={isParent ? "sg-app parent-theme" : "sg-app adult-theme"}>
      <style>{`
        *{box-sizing:border-box}
        .sg-app{min-height:100vh;display:flex;background:#f3f6fa;color:#1d2a3b;font-family:Inter,system-ui,Arial,sans-serif}
        .sg-sidebar{width:255px;flex:none;background:#101e35;color:#fff;padding:24px 16px;display:flex;flex-direction:column;min-height:100vh}
        .adult-theme .sg-sidebar{background:#123b37}
        .sg-brand{display:flex;align-items:center;gap:11px;padding:5px 8px 28px;border-bottom:1px solid #ffffff20}
        .sg-brand-icon{width:42px;height:42px;border-radius:13px;background:#254d79;display:grid;place-items:center}
        .sg-brand b,.sg-brand small{display:block}
        .sg-brand b{font-size:17px}
        .sg-brand small{font-size:10px;color:#b7c7d8;margin-top:3px}
        .sg-nav-label{font-size:9px;letter-spacing:1.4px;color:#91a6bd;font-weight:850;margin:28px 10px 12px}
        .sg-nav{width:100%;display:flex;align-items:center;gap:11px;padding:12px;border:0;border-radius:10px;background:transparent;color:#c4d0de;text-align:left;font-size:12px;font-weight:650;cursor:pointer;margin:3px 0}
        .sg-nav.active{background:#ffffff18;color:#fff}
        .sg-sidebar-bottom{margin-top:auto}
        .sg-user{display:flex;align-items:center;gap:9px;padding:14px 4px 0;border-top:1px solid #ffffff20}
        .sg-user-avatar{width:34px;height:34px;border-radius:50%;background:#355b80;display:grid;place-items:center;font-weight:800}
        .sg-user-info{flex:1;min-width:0}
        .sg-user-info b,.sg-user-info small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .sg-user-info b{font-size:11px}
        .sg-user-info small{font-size:9px;color:#b7c7d8;margin-top:3px}
        .sg-logout{border:0;background:transparent;color:#d4dfeb;cursor:pointer}
        .sg-main{flex:1;min-width:0}
        .sg-topbar{height:68px;background:#fff;border-bottom:1px solid #e8edf2;display:flex;align-items:center;justify-content:space-between;padding:0 30px}
        .sg-topbar>b{font-size:15px}
        .sg-role-tag{font-size:9px;font-weight:850;letter-spacing:1px;color:#607a96;background:#edf2f7;padding:8px 11px;border-radius:20px}
        .sg-content{max-width:1250px;margin:auto;padding:28px}
        .parent-banner{background:linear-gradient(115deg,#152f50,#28557e);border-radius:20px;padding:32px;min-height:180px;display:flex;align-items:center;justify-content:space-between;color:#fff}
        .parent-banner h1,.adult-banner h1{font-size:29px;margin:12px 0 8px}
        .parent-banner p,.adult-banner p{font-size:12px;margin:0;max-width:470px;line-height:1.7;color:#c5d5e5}
        .parent-label,.adult-label{display:flex;align-items:center;gap:7px;font-size:10px;letter-spacing:1.2px;font-weight:850}
        .parent-emblem,.adult-emblem{display:flex;flex-direction:column;align-items:center;gap:7px;opacity:.85}
        .parent-emblem b,.adult-emblem b{font-size:9px;letter-spacing:1px;text-align:center;line-height:1.5}
        .parent-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:13px;margin:17px 0}
        .parent-stats>div{background:#fff;border:1px solid #e5ebf2;border-radius:14px;padding:17px}
        .parent-stats small,.parent-stats b,.parent-stats span{display:block}
        .parent-stats small{font-size:9px;letter-spacing:.7px;color:#8492a3;font-weight:800}
        .parent-stats b{font-size:27px;margin:8px 0 3px;color:#244b72}
        .parent-stats span{font-size:10px;color:#8290a2}
        .parent-stats .stat-alert b{color:#d04c43}
        .parent-grid,.adult-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:15px;margin:15px 0}
        .parent-panel,.adult-panel{background:#fff;border:1px solid #e5ebf2;border-radius:16px;padding:20px;margin-bottom:15px;min-width:0}
        .panel-title{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:17px;color:#345b80}
        .panel-title>div{min-width:0}
        .panel-title small{font-size:9px;letter-spacing:1.4px;color:#64809e;font-weight:850}
        .panel-title h2{font-size:19px;margin:5px 0}
        .panel-title p{font-size:12px;color:#77869a;margin:0}
        .parent-invite-form{display:flex;gap:8px;margin-bottom:14px}
        .parent-invite-form input,.sg-form input{flex:1;min-width:0;padding:12px;border:1px solid #dce3eb;border-radius:9px}
        .parent-btn,.adult-btn,.sg-button{border:0;border-radius:9px;background:#193d65;color:#fff;padding:11px 14px;display:inline-flex;align-items:center;justify-content:center;gap:7px;font-weight:750;cursor:pointer;text-decoration:none}
        .family-row{display:flex;align-items:center;gap:10px;border-top:1px solid #edf0f4;padding:13px 0}
        .family-row>div{flex:1;min-width:0}
        .family-row b,.family-row small{display:block}
        .family-row b{font-size:13px}
        .family-row small{font-size:10px;color:#8290a2;overflow-wrap:anywhere}
        .family-avatar{width:36px;height:36px;border-radius:10px;background:#eaf0f8;color:#345b83;display:grid;place-items:center}
        .sg-badge{font-size:10px;font-weight:800;padding:6px 9px;border-radius:20px;background:#edf0f3;color:#647080}
        .sg-badge.green{background:#e3f5e9;color:#267348}
        .sg-badge.orange{background:#fff1dc;color:#98621b}
        .sg-empty{padding:18px;border-radius:11px;background:#f3f6f9;color:#758397;font-size:12px;line-height:1.6}
        .sg-location{display:flex;flex-direction:column;gap:13px}
        .sg-coordinate{display:flex;align-items:center;gap:13px;padding:14px;background:#eef3f8;border-radius:12px;color:#244d77}
        .sg-coordinate p{margin:5px 0;font-size:13px}
        .sg-coordinate small{display:block;font-size:10px;color:#728196;margin-top:5px}
        .sg-coordinate .sg-place-name{font-size:16px;font-weight:800;line-height:1.45;color:#234d77;margin:8px 0}
        .sg-plan{display:flex;align-items:center;gap:12px;padding:14px 0;border-bottom:1px solid #edf0f4}
        .sg-plan-icon{width:38px;height:38px;border-radius:10px;background:#edf2f8;color:#42658b;display:grid;place-items:center}
        .sg-plan-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px}
        .sg-plan-info b{font-size:13px}
        .sg-plan-info span,.sg-plan-info small{display:flex;align-items:center;gap:5px;color:#758397;font-size:11px}
        .sg-success{display:flex;align-items:center;gap:9px;background:#e9f7ee;color:#287549;padding:17px;border-radius:11px;font-size:13px}
        .parent-subtitle{font-weight:800;font-size:12px;margin:17px 0 5px}
        .sg-activity{display:flex;gap:11px;padding:12px 0;border-bottom:1px solid #edf0f4}
        .sg-activity>div{min-width:0}
        .sg-activity b{font-size:12px}
        .sg-activity p{font-size:11px;color:#77869a;margin:4px 0}
        .sg-activity small{font-size:10px;color:#98a3b1}
        .activity-green,.activity-red{width:32px;height:32px;flex:none;border-radius:9px;display:grid;place-items:center;background:#e6f5eb;color:#2b8050}
        .activity-red{background:#fff0ee;color:#d04b42}
        .adult-banner{background:linear-gradient(115deg,#e8f5f1,#d8eeea);border:1px solid #d2e9e3;border-radius:20px;padding:32px;min-height:180px;display:flex;align-items:center;justify-content:space-between;color:#174b43}
        .adult-banner p{color:#5b7b74}
        .adult-label{color:#318579}
        .adult-emblem{color:#278b7c}
        .adult-status{background:#fff;border:1px solid #e0ebe7;border-radius:17px;padding:19px;display:flex;align-items:center;gap:15px;margin:18px 0}
        .adult-status-icon{width:48px;height:48px;border-radius:14px;background:#e6f5f0;color:#328a7d;display:grid;place-items:center}
        .adult-status-copy{flex:1}
        .adult-status-copy small{font-size:9px;letter-spacing:1px;color:#73918a;font-weight:850}
        .adult-status-copy h2{font-size:18px;margin:5px 0}
        .adult-status-copy p{font-size:11px;color:#71847f;margin:0}
        .adult-sos{border:0;border-radius:11px;background:#d94343;color:#fff;padding:14px 16px;display:flex;align-items:center;gap:8px;font-weight:850;cursor:pointer}
        .adult-actions{display:grid;grid-template-columns:repeat(3,1fr);gap:13px;margin:18px 0}
        .adult-actions button{border:1px solid #deebe7;background:#fff;border-radius:15px;padding:17px;text-align:left;display:flex;flex-direction:column;align-items:flex-start;gap:9px;color:#244d46;cursor:pointer;min-height:145px}
        .adult-actions button>span{width:39px;height:39px;border-radius:11px;background:#e6f5f0;color:#328b7d;display:grid;place-items:center}
        .adult-actions b{font-size:14px}
        .adult-actions small{font-size:11px;color:#7a8c86;flex:1}
        .adult-actions button>svg{align-self:flex-end}
        .adult-panel{border-color:#dfeae6}
        .adult-panel .panel-title small{color:#39877d}
        .adult-invite-row,.sharing-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:13px 0;border-top:1px solid #edf2f0}
        .adult-invite-row>div,.sharing-row>div{display:flex;flex-direction:column;gap:5px}
        .adult-invite-row small,.sharing-row small{font-size:10px;color:#788c86}
        .adult-btn{background:#258477}
        .sharing-row{margin-top:12px}
        .sharing-toggle{border:0;border-radius:20px;padding:8px 14px;background:#e9edef;color:#64716e;font-weight:850;cursor:pointer}
        .sharing-toggle.on{background:#ddf3e5;color:#23784a}
        .adult-text-button{border:0;background:transparent;color:#288477;font-weight:800;padding:13px 0;cursor:pointer}
        .green-button{background:#268455}
        .sg-button{background:#244c75}
        .sg-form{display:grid;gap:13px}
        .sg-form label,.auth-box label{display:grid;gap:7px;font-size:12px;font-weight:700}
        .sg-form input{width:100%}
        .page-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
        .page-heading h1{margin:6px 0}
        .page-heading small{font-size:10px;letter-spacing:1px;color:#70829a;font-weight:800}
        .sg-error{color:#b83d36;font-size:12px}
        .sg-loading{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:#23496e}
        .auth-screen{min-height:100vh;background:linear-gradient(135deg,#101e35,#1c4569);display:grid;place-items:center;padding:20px;font-family:Inter,system-ui,Arial}
        .auth-box{background:#fff;width:min(100%,440px);padding:32px;border-radius:20px;display:flex;flex-direction:column;gap:15px;box-shadow:0 25px 80px #0003}
        .auth-logo{display:flex;align-items:center;gap:10px;color:#234d77;margin-bottom:10px}
        .auth-logo b,.auth-logo small{display:block}
        .auth-logo small{font-size:10px;color:#8793a2}
        .auth-kicker{font-size:10px;letter-spacing:1.5px;color:#63809e;font-weight:850}
        .auth-box h1{margin:0;font-size:28px}
        .auth-box>p{margin:0;color:#78869a;font-size:12px}
        .auth-box input,.auth-box select{width:100%;padding:12px;border:1px solid #dce3eb;border-radius:9px;background:#fff}
        .password-input{display:flex}
        .password-input input{flex:1}
        .password-input button{border:0;background:transparent;margin-left:-38px;z-index:1}
        .auth-submit{border:0;border-radius:10px;background:#1e4770;color:#fff;padding:14px;font-weight:800;display:flex;justify-content:center;align-items:center;gap:10px;cursor:pointer}
        .auth-link{border:0;background:transparent;color:#2d6e9a;font-size:12px;cursor:pointer}
        .auth-security{border-top:1px solid #edf0f4;padding-top:14px;display:flex;align-items:center;gap:8px;color:#7c8999;font-size:10px}
        .auth-error,.auth-success{padding:11px;border-radius:9px;font-size:12px;background:#fff0ed;color:#b23d36}
        .auth-success{background:#eaf7ef;color:#267447}
        @media(max-width:900px){
          .sg-sidebar{width:205px}
          .parent-stats{grid-template-columns:repeat(2,1fr)}
          .parent-grid,.adult-grid{grid-template-columns:1fr}
        }
        @media(max-width:650px){
          .sg-app{display:block}
          .sg-sidebar{width:100%;min-height:auto;padding:12px}
          .sg-nav-label,.sg-sidebar-bottom{display:none}
          .sg-brand{padding:5px;border:0}
          .sg-topbar{height:55px;padding:0 15px}
          .sg-content{padding:15px}
          .parent-banner,.adult-banner{padding:22px}
          .parent-emblem,.adult-emblem{display:none}
          .adult-actions{grid-template-columns:1fr}
          .adult-status{flex-wrap:wrap}
          .adult-sos{margin-left:auto}
          .parent-stats{gap:8px}
          .parent-stats>div{padding:13px}
          .parent-invite-form{flex-direction:column}
        }
      `}</style>

      <aside className="sg-sidebar">
        <div className="sg-brand">
          <span className="sg-brand-icon">
            <ShieldCheck />
          </span>
          <div>
            <b>SafeGuardian</b>
            <small>{isParent ? "Parent Control Centre" : "Personal Safety"}</small>
          </div>
        </div>

        <div className="sg-nav-label">YOUR WORKSPACE</div>

        {nav.map(([label, Icon]) => (
          <button
            key={label}
            className={`sg-nav ${page === label ? "active" : ""}`}
            onClick={() => {
              setPage(label);
              setMobile(false);
            }}
          >
            <Icon size={18} /> {label}
          </button>
        ))}

        <div className="sg-sidebar-bottom">
          <div className="sg-user">
            <span className="sg-user-avatar">
              {(profile.display_name || user.email).slice(0, 1).toUpperCase()}
            </span>

            <div className="sg-user-info">
              <b>{profile.display_name || user.email}</b>
              <small>{isParent ? "Parent account" : "Adult account"}</small>
            </div>

            <button className="sg-logout" onClick={signOut}>
              <LogOut />
            </button>
          </div>
        </div>
      </aside>

      <main className="sg-main">
        <header className="sg-topbar">
          <b>{page}</b>
          <span className="sg-role-tag">
            {isParent ? "PARENT DASHBOARD" : "ADULT DASHBOARD"}
          </span>
        </header>

        <div className="sg-content">
          {error && (
            <div className="auth-error">
              <AlertTriangle size={15} /> {error}
              <button onClick={() => setError("")}>×</button>
            </div>
          )}

          {renderPage()}

          <footer style={{ padding: "25px 0", fontSize: 11, color: "#8b98a8" }}>
            SafeGuardian · Privacy-first family safety platform
          </footer>
        </div>
      </main>

      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 22,
            right: 22,
            background: "#183c5d",
            color: "#fff",
            padding: "14px 20px",
            borderRadius: 12,
            zIndex: 50,
            fontSize: 13
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}  